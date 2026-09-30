import type { EscalationChannel, Prisma } from '@loons/db';
import {
  STAFF_ROLES,
  escalationTeamWarnings,
  normalizeE164,
  type AdminListQuery,
  type CreateEscalationRuleInput,
  type EscalationRuleAdminDto,
  type EscalationTeamFacts,
  type EscalationWarning,
  type ReorderEscalationInput,
  type UpdateEscalationRuleInput,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh, shareActive } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { applyReorder, renumberUnique } from './reorder.ts';
import type { AdminContext } from './write.ts';

// Admin — Escalation rules (spec §10.6; decisions D3, E5, E13). The P1 chain, global (teamId null)
// and per team: a team's own active rules replace the global chain for that team. Steps fire
// `afterMins` after the ticket became P1 (cumulative). Rules are archived, never deleted, and the
// step number is unique per chain across archived rows too (a NULLS NOT DISTINCT index), so:
// - adding a step whose number an archived rule holds is 409 `duplicate` with `existingId`
//   (restore that rule instead, or add the step at the end);
// - reordering renumbers the chain's active rules 1…n and moves its archived rules after them, in
//   two phases (`renumberUnique`) so no intermediate state collides.
// A chain's delays never go down by step (a later step never fires before an earlier one, and the
// P1 alert's "next step in" is never negative): create, an edit of the delay and restore are 400
// `validation.chainOrder` on `afterMins` otherwise; a reorder keeps the delays in place (step k
// keeps its time slot, the targets and channels move), so a moved rule's delay changes with it.
// Edits re-time pending steps in the worker (jobs/escalation.ts): a step that fires early waits
// again until `p1Since + afterMins`; one that is now overdue is promoted by the next SLA scan.
// Every change announces `escalation` (ticket details show the chain). The on-call user is a Team
// field (Teams & members). A team rule needs an active team: create reads the team FOR SHARE (a
// concurrent team archive either finishes first or then counts the new rule), and restoring a
// rule of an archived team is refused (409 guard `escalation_team_archived`, E5). Contract: packages/shared/src/schemas/admin/escalation.ts.

type Tx = Prisma.TransactionClient;

/** 409 guards of this section (besides the shared ones). */
export const ESCALATION_GUARDS = { teamArchived: 'escalation_team_archived' } as const;

/** The loader (lib/escalation.ts) only reads P1 chains. */
const PRIORITY = 'P1' as const;

export interface EscalationListQuery extends AdminListQuery {
  /** A team's own chain, or `global`; omitted = every chain. */
  teamId?: string | undefined;
}

export interface EscalationAdminService {
  list(ctx: AdminContext, query: EscalationListQuery): Promise<EscalationRuleAdminDto[]>;
  create(ctx: AdminContext, input: CreateEscalationRuleInput): Promise<EscalationRuleAdminDto>;
  update(
    ctx: AdminContext,
    id: string,
    input: UpdateEscalationRuleInput,
  ): Promise<EscalationRuleAdminDto>;
  setActive(
    ctx: AdminContext,
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<EscalationRuleAdminDto>;
  reorder(ctx: AdminContext, input: ReorderEscalationInput): Promise<void>;
}

const ruleInclude = {
  team: { select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true } },
  targetUser: { select: { id: true, name: true, status: true, role: true, phone: true } },
} as const satisfies Prisma.EscalationRuleInclude;

type RuleRow = Prisma.EscalationRuleGetPayload<{ include: typeof ruleInclude }>;

/** What the warnings need to know about a team. */
interface TeamFacts extends EscalationTeamFacts {
  id: string;
}

const isActiveStaff = (user: { status: string; role: string } | null): boolean =>
  user !== null &&
  user.status === 'ACTIVE' &&
  (STAFF_ROLES as readonly string[]).includes(user.role);

async function loadTeamFacts(db: Tx | AdminDeps['prisma']): Promise<Map<string, TeamFacts>> {
  // Sequential: `db` may be a transaction, whose connection runs one query at a time.
  const teams = await db.team.findMany({
    select: {
      id: true,
      isActive: true,
      teamsWebhookUrl: true,
      onCallUser: { select: { status: true, role: true, phone: true } },
    },
  });
  const owners = await db.escalationRule.findMany({
    where: { priority: PRIORITY, isActive: true, teamId: { not: null } },
    distinct: ['teamId'],
    select: { teamId: true },
  });
  const withOwnChain = new Set(owners.map((o) => o.teamId));
  return new Map(
    teams.map((t) => [
      t.id,
      {
        id: t.id,
        hasWebhook: Boolean(t.teamsWebhookUrl?.trim()),
        onCall: isActiveStaff(t.onCallUser)
          ? { phoneValid: normalizeE164(t.onCallUser?.phone) !== null }
          : null,
        usesGlobalChain: t.isActive && !withOwnChain.has(t.id),
      },
    ]),
  );
}

/**
 * Warnings shown next to a rule (it still saves). A team rule is checked against its team; a
 * global rule against every active team that follows the global chain ("some teams …").
 */
export function escalationWarnings(
  rule: Pick<RuleRow, 'teamId' | 'targetType' | 'channels'> & {
    targetUser: { status: string; role: string; phone: string | null } | null;
  },
  teams: ReadonlyMap<string, TeamFacts>,
): EscalationWarning[] {
  // The team ones are shared with the rule sheet (it checks the draft as the admin edits it).
  const out = escalationTeamWarnings(rule, teams);
  const sms = rule.channels.includes('SMS');
  if (rule.targetType === 'USER') {
    if (!isActiveStaff(rule.targetUser)) out.push('target_user_inactive');
    else if (sms && normalizeE164(rule.targetUser?.phone) === null) {
      out.push('target_user_no_phone');
    }
  }
  return out;
}

function ruleDto(row: RuleRow, teams: ReadonlyMap<string, TeamFacts>): EscalationRuleAdminDto {
  return {
    id: row.id,
    priority: row.priority,
    teamId: row.teamId,
    team: row.team,
    step: row.step,
    targetType: row.targetType,
    targetRole: row.targetRole,
    targetUser: row.targetUser
      ? {
          id: row.targetUser.id,
          name: row.targetUser.name,
          isActive: isActiveStaff(row.targetUser),
        }
      : null,
    afterMins: row.afterMins,
    channels: row.channels,
    isActive: row.isActive,
    warnings: escalationWarnings(row, teams),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields an audit row shows for a rule. */
function auditFields(row: {
  teamId: string | null;
  step: number;
  targetType: string;
  targetRole: string | null;
  targetUserId: string | null;
  afterMins: number;
  channels: readonly string[];
  isActive: boolean;
}) {
  return {
    teamId: row.teamId,
    step: row.step,
    targetType: row.targetType,
    targetRole: row.targetRole,
    targetUserId: row.targetUserId,
    afterMins: row.afterMins,
    channels: [...row.channels],
    isActive: row.isActive,
  };
}

function chainName(teamId: string | null): string {
  return `${PRIORITY}:${teamId ?? 'global'}`;
}

function ruleLabel(row: { step: number; team: { nameEn: string } | null }): string {
  return `${PRIORITY} ${row.team ? row.team.nameEn : 'global'} chain, step ${row.step}`;
}

function bodyIssue(path: string, message: string, code: string): ValidationIssue {
  return { location: 'body', path: [path], message, code };
}

/** Channels in a stable order, without duplicates. */
function channelList(channels: readonly EscalationChannel[]): EscalationChannel[] {
  const order: EscalationChannel[] = ['EMAIL', 'TEAMS', 'SMS'];
  return order.filter((c) => channels.includes(c));
}

export function createEscalationAdminService(deps: AdminDeps): EscalationAdminService {
  const { prisma, writer } = deps;

  /** 400 unless `userId` is an active staff user. */
  async function assertTargetUser(tx: Tx, userId: string): Promise<void> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, role: true },
    });
    if (!isActiveStaff(user)) {
      throw errors.validation([bodyIssue('targetUserId', 'validation.invalid', 'target_user')]);
    }
  }

  /**
   * 400 `validation.chainOrder` unless a rule at `step` with `afterMins` fires no earlier than the
   * chain's active steps before it and no later than the ones after it. Under the chain's lock.
   */
  async function assertChainOrder(
    tx: Tx,
    rule: { id?: string; teamId: string | null; step: number; afterMins: number },
  ): Promise<void> {
    const others = await tx.escalationRule.findMany({
      where: {
        priority: PRIORITY,
        teamId: rule.teamId,
        isActive: true,
        ...(rule.id ? { id: { not: rule.id } } : {}),
      },
      select: { step: true, afterMins: true },
    });
    const outOfOrder = others.some((o) =>
      o.step < rule.step ? o.afterMins > rule.afterMins : o.afterMins < rule.afterMins,
    );
    if (outOfOrder) {
      throw errors.validation([bodyIssue('afterMins', 'validation.chainOrder', 'chain_order')]);
    }
  }

  async function dto(tx: Tx, id: string): Promise<EscalationRuleAdminDto> {
    const row = await tx.escalationRule.findUniqueOrThrow({ where: { id }, include: ruleInclude });
    return ruleDto(row, await loadTeamFacts(tx));
  }

  return {
    async list(ctx, query) {
      requireSuperAdmin(ctx.actor);
      const term = query.search?.trim();
      const [rows, teams] = await Promise.all([
        prisma.escalationRule.findMany({
          where: {
            priority: PRIORITY,
            ...(query.status === 'all' ? {} : { isActive: query.status !== 'archived' }),
            ...(query.teamId === 'global'
              ? { teamId: null }
              : query.teamId
                ? { teamId: query.teamId }
                : {}),
            ...(term
              ? {
                  OR: [
                    { targetUser: { name: { contains: term, mode: 'insensitive' } } },
                    { team: { nameEn: { contains: term, mode: 'insensitive' } } },
                    { team: { nameAr: { contains: term, mode: 'insensitive' } } },
                  ],
                }
              : {}),
          },
          include: ruleInclude,
        }),
        loadTeamFacts(prisma),
      ]);
      // Global chain first, then teams by name; steps in order.
      rows.sort((a, b) => {
        if (a.teamId !== b.teamId) {
          if (a.teamId === null) return -1;
          if (b.teamId === null) return 1;
          const byName = (a.team?.nameEn ?? '').localeCompare(b.team?.nameEn ?? '');
          return byName !== 0 ? byName : a.teamId.localeCompare(b.teamId);
        }
        return a.step - b.step;
      });
      return rows.map((row) => ruleDto(row, teams));
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'escalation' }, async ({ tx, audit }) => {
        await advisoryLock(tx, `escalation:${chainName(input.teamId)}`);
        if (input.teamId) {
          const team = await shareActive(tx, 'Team', input.teamId);
          if (!team?.isActive) {
            throw errors.validation([bodyIssue('teamId', 'validation.invalid', 'team')]);
          }
        }
        if (input.targetType === 'USER' && input.targetUserId) {
          await assertTargetUser(tx, input.targetUserId);
        }
        const taken = await tx.escalationRule.findFirst({
          where: { priority: PRIORITY, teamId: input.teamId, step: input.step },
          select: { id: true, isActive: true },
        });
        if (taken) throw adminErrors.duplicate(['step'], taken);
        await assertChainOrder(tx, input);
        const created = await tx.escalationRule.create({
          data: {
            priority: PRIORITY,
            teamId: input.teamId,
            step: input.step,
            targetType: input.targetType,
            targetRole: input.targetType === 'ROLE' ? input.targetRole : null,
            targetUserId: input.targetType === 'USER' ? input.targetUserId : null,
            afterMins: input.afterMins,
            channels: channelList(input.channels),
          },
          include: ruleInclude,
        });
        await audit.record({
          action: 'CREATE',
          entity: 'EscalationRule',
          entityId: created.id,
          entityLabel: ruleLabel(created),
          after: auditFields(created),
        });
        return dto(tx, created.id);
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        if (input.afterMins !== undefined) {
          // The chain's timing may change: its lock first (create / reorder take it before rows).
          const scope = await tx.escalationRule.findUnique({
            where: { id },
            select: { teamId: true },
          });
          if (scope) await advisoryLock(tx, `escalation:${chainName(scope.teamId)}`);
        }
        await lockFresh(tx, 'EscalationRule', id, input.expectedUpdatedAt);
        const before = await tx.escalationRule.findUniqueOrThrow({
          where: { id },
          include: ruleInclude,
        });
        const targetType = input.targetType ?? before.targetType;
        const typeChanged = targetType !== before.targetType;
        // Changing the type clears the other target field; the matching one must be sent.
        const targetRole =
          targetType === 'ROLE'
            ? input.targetRole !== undefined
              ? input.targetRole
              : typeChanged
                ? null
                : before.targetRole
            : null;
        const targetUserId =
          targetType === 'USER'
            ? input.targetUserId !== undefined
              ? input.targetUserId
              : typeChanged
                ? null
                : before.targetUserId
            : null;
        const issues: ValidationIssue[] = [];
        if (targetType === 'ROLE' && targetRole === null) {
          issues.push(bodyIssue('targetRole', 'validation.targetMismatch', 'target'));
        }
        if (targetType !== 'ROLE' && input.targetRole != null) {
          issues.push(bodyIssue('targetRole', 'validation.targetMismatch', 'target'));
        }
        if (targetType === 'USER' && targetUserId === null) {
          issues.push(bodyIssue('targetUserId', 'validation.targetMismatch', 'target'));
        }
        if (targetType !== 'USER' && input.targetUserId != null) {
          issues.push(bodyIssue('targetUserId', 'validation.targetMismatch', 'target'));
        }
        if (issues.length) throw errors.validation(issues);
        if (targetType === 'USER' && targetUserId && targetUserId !== before.targetUserId) {
          await assertTargetUser(tx, targetUserId);
        }
        const next = {
          targetType,
          targetRole,
          targetUserId,
          afterMins: input.afterMins ?? before.afterMins,
          channels: input.channels ? channelList(input.channels) : before.channels,
        };
        const same =
          next.targetType === before.targetType &&
          next.targetRole === before.targetRole &&
          next.targetUserId === before.targetUserId &&
          next.afterMins === before.afterMins &&
          next.channels.join() === before.channels.join();
        if (same) return ruleDto(before, await loadTeamFacts(tx));
        if (before.isActive && next.afterMins !== before.afterMins) {
          await assertChainOrder(tx, { ...before, afterMins: next.afterMins });
        }
        const updated = await tx.escalationRule.update({
          where: { id },
          data: next,
          include: ruleInclude,
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'EscalationRule',
          entityId: id,
          entityLabel: ruleLabel(updated),
          before: auditFields(before),
          after: auditFields(updated),
        });
        after.scope('escalation');
        return dto(tx, id);
      });
    },

    async setActive(ctx, id, active, expectedUpdatedAt) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        // The chain's lock before the row lock, like create / update / reorder: every escalation
        // writer takes them in that order, so a PATCH and an archive of the same rule queue
        // instead of deadlocking. (A rule's team never changes, so reading it unlocked is safe.)
        const scope = await tx.escalationRule.findUnique({
          where: { id },
          select: { teamId: true },
        });
        if (scope) await advisoryLock(tx, `escalation:${chainName(scope.teamId)}`);
        await lockFresh(tx, 'EscalationRule', id, expectedUpdatedAt);
        const before = await tx.escalationRule.findUniqueOrThrow({
          where: { id },
          include: ruleInclude,
        });
        if (before.isActive === active) return ruleDto(before, await loadTeamFacts(tx));
        if (active && before.teamId && !(await shareActive(tx, 'Team', before.teamId))?.isActive) {
          throw adminErrors.guard(
            ESCALATION_GUARDS.teamArchived,
            'This rule belongs to an archived team. Restore the team first.',
          );
        }
        if (active) await assertChainOrder(tx, before);
        const updated = await tx.escalationRule.update({
          where: { id },
          data: { isActive: active },
          include: ruleInclude,
        });
        await audit.record({
          action: active ? 'RESTORE' : 'ARCHIVE',
          entity: 'EscalationRule',
          entityId: id,
          entityLabel: ruleLabel(updated),
          before: { isActive: before.isActive },
          after: { isActive: updated.isActive },
        });
        after.scope('escalation');
        return dto(tx, id);
      });
    },

    async reorder(ctx, input) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
        const chain = chainName(input.teamId);
        await advisoryLock(tx, `escalation:${chain}`);
        const rows = () =>
          tx.escalationRule.findMany({
            where: { priority: PRIORITY, teamId: input.teamId },
            orderBy: { step: 'asc' },
            select: { id: true, isActive: true, step: true, afterMins: true },
          });
        // The rules whose delay moved (the audit shows them).
        const delays = {
          before: {} as Record<string, number>,
          after: {} as Record<string, number>,
        };
        const result = await applyReorder(tx, {
          list: `EscalationRule:${chain}`,
          body: input,
          currentIds: async () => (await rows()).filter((r) => r.isActive).map((r) => r.id),
          write: async (ids) => {
            const all = await rows();
            // Active rules 1…n in the new order, archived ones after them (their relative order
            // kept): no step collides with an archived rule's number.
            const archived = all.filter((r) => !r.isActive).map((r) => r.id);
            await renumberUnique(tx, 'EscalationRule', [...ids, ...archived], 1);
            // Each step keeps its time slot (the chain's delays, in order): a moved rule takes the
            // delay of its new place, so the delays never go down by step. Pending steps of open
            // P1s are re-timed by the worker (E13).
            const slots = all
              .filter((r) => r.isActive)
              .map((r) => r.afterMins)
              .sort((a, b) => a - b);
            const byId = new Map(all.map((r) => [r.id, r]));
            for (const [i, ruleId] of ids.entries()) {
              const was = byId.get(ruleId)?.afterMins;
              const slot = slots[i];
              if (was === undefined || slot === undefined || was === slot) continue;
              await tx.escalationRule.update({ where: { id: ruleId }, data: { afterMins: slot } });
              delays.before[ruleId] = was;
              delays.after[ruleId] = slot;
            }
          },
        });
        if (!result) return;
        const moved = Object.keys(delays.before).length > 0;
        const team = input.teamId
          ? await tx.team.findUnique({ where: { id: input.teamId }, select: { nameEn: true } })
          : null;
        await audit.record({
          action: 'REORDER',
          entity: 'EscalationRule',
          entityId: input.teamId ?? 'global',
          entityLabel: `${PRIORITY} ${team ? team.nameEn : 'global'} chain`,
          before: { order: result.before, ...(moved ? { afterMins: delays.before } : {}) },
          after: { order: result.after, ...(moved ? { afterMins: delays.after } : {}) },
        });
        after.scope('escalation');
      });
    },
  };
}
