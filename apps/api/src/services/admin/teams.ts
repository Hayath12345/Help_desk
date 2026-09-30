import type { Prisma } from '@loons/db';
import {
  STAFF_ROLES,
  normalizeE164,
  type Actor,
  type AddTeamMemberInput,
  type AdminListQuery,
  type ArchiveBody,
  type CreateTeamInput,
  type ReorderBody,
  type TeamAdminDto,
  type TeamMemberAdminDto,
  type TeamMemberRoleResponse,
  type UpdateTeamInput,
  type UpdateTeamMemberInput,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { urlHost } from '../../lib/pii.ts';
import { webhookUrlProblem } from '../../lib/teams/webhook.ts';
import {
  requireMemberChange,
  requireMemberRoleChange,
  requireOnCallChange,
  requireTeamAccess,
  requireTeamSettings,
  teamScopeFilter,
} from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import { applyReorder, writeSortOrder } from './reorder.ts';
import type { AdminContext, AfterCommit } from './write.ts';

// Admin — Teams & members (spec §10.3; decisions E5, E6, E7).
// Contract: packages/shared/src/schemas/admin/teams.ts; routes: ../../routes/admin/teams.ts.
//
// - Super admins manage everything. Team leads (E7) see only the teams they lead, add / remove
//   MEMBER rows there and choose the on-call user; names, email list, Teams webhook, archive,
//   order and LEAD rows are super admin only (403).
// - The Teams webhook URL is a secret (D12): validated against TEAMS_WEBHOOK_HOSTS on write, never
//   returned (reads give `{ configured, host }`), audited as its host only.
// - Every membership change invalidates the member's principal (their sockets re-sync their team
//   rooms). Creating, archiving or restoring a team changes the rooms super admins join (active
//   teams): their principals are invalidated too.
// - Archive never removes anything (E5) and is refused while active categories route to the team,
//   it has open tickets, or active escalation rules of the team exist. The on-call user must be an
//   active staff member of the team with an E.164 phone; a member who is on call can't be removed.
// Scope `teams` (form config team names, teams list, ticket details).

type Tx = Prisma.TransactionClient;

/** Ticket statuses that block archiving a team (work still to do). */
export const OPEN_TICKET_STATUSES = ['NEW', 'OPEN', 'PENDING'] as const;

export const TEAM_GUARDS = {
  activeCategories: 'team_has_active_categories',
  openTickets: 'team_has_open_tickets',
  escalation: 'team_in_escalation',
  archived: 'team_archived',
  onCallMember: 'member_is_on_call',
} as const;

const memberSelect = {
  role: true,
  createdAt: true,
  user: {
    select: { id: true, name: true, email: true, role: true, status: true, phone: true },
  },
} satisfies Prisma.TeamMemberSelect;

const teamSelect = {
  id: true,
  key: true,
  nameEn: true,
  nameAr: true,
  emails: true,
  teamsWebhookUrl: true,
  onCallUserId: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  onCallUser: { select: { id: true, name: true, phone: true, status: true, role: true } },
  members: { select: memberSelect },
  _count: {
    select: {
      categories: { where: { isActive: true } },
      tickets: { where: { status: { in: [...OPEN_TICKET_STATUSES] } } },
    },
  },
} satisfies Prisma.TeamSelect;

type TeamRow = Prisma.TeamGetPayload<{ select: typeof teamSelect }>;
type MemberRow = Prisma.TeamMemberGetPayload<{ select: typeof memberSelect }>;

const isStaffRole = (role: string) => (STAFF_ROLES as readonly string[]).includes(role);

export function toTeamMemberDto(row: MemberRow): TeamMemberAdminDto {
  const { user } = row;
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    memberRole: row.role,
    hasPhone: Boolean(user.phone?.trim()),
    phoneValid: normalizeE164(user.phone) !== null,
    since: row.createdAt.toISOString(),
  };
}

export function toTeamDto(row: TeamRow): TeamAdminDto {
  const members = row.members
    .map(toTeamMemberDto)
    .sort(
      (a, b) =>
        (a.memberRole === b.memberRole ? 0 : a.memberRole === 'LEAD' ? -1 : 1) ||
        a.name.localeCompare(b.name) ||
        a.userId.localeCompare(b.userId),
    );
  const onCall = row.onCallUser;
  return {
    id: row.id,
    key: row.key,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    emails: row.emails,
    teamsWebhook: {
      configured: Boolean(row.teamsWebhookUrl),
      host: row.teamsWebhookUrl ? urlHost(row.teamsWebhookUrl) : null,
    },
    onCallUser: onCall
      ? {
          id: onCall.id,
          name: onCall.name,
          phoneValid: normalizeE164(onCall.phone) !== null,
          isMember: members.some((m) => m.userId === onCall.id),
          isActive: onCall.status === 'ACTIVE' && isStaffRole(onCall.role),
        }
      : null,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    members,
    activeCategoryCount: row._count.categories,
    openTicketCount: row._count.tickets,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields of a team the audit log compares (the webhook URL is reduced to its host there). */
function auditFields(row: {
  key: string;
  nameEn: string;
  nameAr: string;
  emails: string[];
  teamsWebhookUrl: string | null;
  onCallUserId: string | null;
  isActive: boolean;
}) {
  return {
    key: row.key,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    emails: row.emails,
    teamsWebhookUrl: row.teamsWebhookUrl,
    onCallUserId: row.onCallUserId,
    isActive: row.isActive,
  };
}

function issue(path: Array<string | number>, message: string, code: string): ValidationIssue {
  return { location: 'body', path, message, code };
}

export interface TeamsAdminService {
  /** Super admins: every team (by `status`); team leads: the teams they lead. */
  list(actor: Actor, query: AdminListQuery): Promise<TeamAdminDto[]>;
  create(ctx: AdminContext, input: CreateTeamInput): Promise<TeamAdminDto>;
  update(ctx: AdminContext, id: string, input: UpdateTeamInput): Promise<TeamAdminDto>;
  archive(ctx: AdminContext, id: string, body: ArchiveBody): Promise<TeamAdminDto>;
  restore(ctx: AdminContext, id: string, body: ArchiveBody): Promise<TeamAdminDto>;
  /** Active teams only (archived ones keep their place after them). */
  reorder(ctx: AdminContext, body: ReorderBody): Promise<void>;
  addMember(
    ctx: AdminContext,
    teamId: string,
    input: AddTeamMemberInput,
  ): Promise<TeamMemberAdminDto>;
  updateMember(
    ctx: AdminContext,
    teamId: string,
    userId: string,
    input: UpdateTeamMemberInput,
  ): Promise<TeamMemberRoleResponse>;
  removeMember(ctx: AdminContext, teamId: string, userId: string): Promise<TeamMemberAdminDto>;
}

export function createTeamsAdminService(deps: AdminDeps): TeamsAdminService {
  const { prisma, writer, config } = deps;

  async function loadTeam(db: Tx | typeof prisma, id: string): Promise<TeamAdminDto> {
    const row = await db.team.findUnique({ where: { id }, select: teamSelect });
    if (!row) throw errors.notFound('Team not found');
    return toTeamDto(row);
  }

  /** Super admins join the rooms of every active team: re-sync them when that set changes. */
  async function refreshSuperAdmins(tx: Tx, after: AfterCommit): Promise<void> {
    const admins = await tx.user.findMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true },
    });
    for (const admin of admins) after.invalidatePrincipal(admin.id);
  }

  function checkWebhook(url: string | null | undefined): void {
    if (!url) return;
    const problem = webhookUrlProblem(url, config.teams.webhookHosts);
    if (problem) {
      throw errors.validation([
        issue(['teamsWebhookUrl'], 'validation.webhookHost', 'teams_webhook_host'),
      ]);
    }
  }

  /** The on-call user must be an active staff member of the team with an E.164 phone. */
  async function checkOnCall(tx: Tx, teamId: string, userId: string): Promise<void> {
    const member = await tx.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { user: { select: { status: true, role: true, phone: true } } },
    });
    if (!member || member.user.status !== 'ACTIVE' || !isStaffRole(member.user.role)) {
      throw errors.validation([
        issue(['onCallUserId'], 'validation.onCallMember', 'on_call_not_member'),
      ]);
    }
    if (normalizeE164(member.user.phone) === null) {
      throw errors.validation([issue(['onCallUserId'], 'validation.onCallPhone', 'on_call_phone')]);
    }
  }

  async function memberRow(tx: Tx, teamId: string, userId: string): Promise<MemberRow | null> {
    return tx.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: memberSelect,
    });
  }

  async function setActive(
    ctx: AdminContext,
    id: string,
    body: ArchiveBody,
    isActive: boolean,
  ): Promise<TeamAdminDto> {
    requireTeamSettings(ctx.actor);
    return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit, after }) => {
      await lockFresh(tx, 'Team', id, body.expectedUpdatedAt);
      const before = await tx.team.findUniqueOrThrow({ where: { id } });
      if (before.isActive === isActive) return loadTeam(tx, id);
      if (!isActive) {
        // One after another: a transaction's connection runs one query at a time.
        const categories = await tx.category.count({ where: { teamId: id, isActive: true } });
        const tickets = await tx.ticket.count({
          where: { teamId: id, status: { in: [...OPEN_TICKET_STATUSES] } },
        });
        const rules = await tx.escalationRule.count({ where: { teamId: id, isActive: true } });
        if (categories > 0) {
          throw adminErrors.guard(
            TEAM_GUARDS.activeCategories,
            'Active categories still route tickets to this team. Route them to another team first.',
          );
        }
        if (tickets > 0) {
          throw adminErrors.guard(
            TEAM_GUARDS.openTickets,
            'This team still has open tickets. Solve or move them first.',
          );
        }
        if (rules > 0) {
          throw adminErrors.guard(
            TEAM_GUARDS.escalation,
            'This team still has active escalation rules. Archive them first.',
          );
        }
      }
      const row = await tx.team.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Team',
        entityId: id,
        entityLabel: row.nameEn,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive },
      });
      await refreshSuperAdmins(tx, after);
      return loadTeam(tx, id);
    });
  }

  return {
    async list(actor, query) {
      const scope = teamScopeFilter(actor);
      const term = query.search?.trim();
      const rows = await prisma.team.findMany({
        where: {
          ...(scope ? { id: scope } : {}),
          ...(query.status === 'all' ? {} : { isActive: query.status === 'active' }),
          ...(term
            ? {
                OR: [
                  { nameEn: { contains: term, mode: 'insensitive' } },
                  { nameAr: { contains: term, mode: 'insensitive' } },
                  { key: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
        select: teamSelect,
      });
      return rows.map(toTeamDto);
    },

    async create(ctx, input) {
      requireTeamSettings(ctx.actor);
      checkWebhook(input.teamsWebhookUrl);
      return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit, after }) => {
        await advisoryLock(tx, 'key:Team');
        const key =
          input.key ??
          (await generateKey({
            label: input.nameEn,
            fallbackPrefix: 'team',
            taken: async (candidates) =>
              (
                await tx.team.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((t) => t.key),
          }));
        if (input.key) {
          const existing = await tx.team.findUnique({
            where: { key: input.key },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        }
        const last = await tx.team.aggregate({ _max: { sortOrder: true } });
        const row = await tx.team.create({
          data: {
            key,
            nameEn: input.nameEn,
            nameAr: input.nameAr,
            emails: input.emails,
            teamsWebhookUrl: input.teamsWebhookUrl,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Team',
          entityId: row.id,
          entityLabel: row.nameEn,
          after: auditFields(row),
        });
        await refreshSuperAdmins(tx, after);
        return loadTeam(tx, row.id);
      });
    },

    async update(ctx, id, input) {
      const { actor } = ctx;
      requireTeamAccess(actor, id);
      const settings =
        input.nameEn !== undefined ||
        input.nameAr !== undefined ||
        input.emails !== undefined ||
        input.teamsWebhookUrl !== undefined;
      if (settings) requireTeamSettings(actor);
      if (input.onCallUserId !== undefined) requireOnCallChange(actor, id);
      checkWebhook(input.teamsWebhookUrl);
      return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Team', id, input.expectedUpdatedAt);
        // Serialises with member removals (the on-call user must stay a member).
        await advisoryLock(tx, `team-members:${id}`);
        const before = await tx.team.findUniqueOrThrow({ where: { id } });
        if (input.onCallUserId && input.onCallUserId !== before.onCallUserId) {
          await checkOnCall(tx, id, input.onCallUserId);
        }
        const row = await tx.team.update({
          where: { id },
          data: {
            ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.emails !== undefined ? { emails: input.emails } : {}),
            ...(input.teamsWebhookUrl !== undefined
              ? { teamsWebhookUrl: input.teamsWebhookUrl }
              : {}),
            ...(input.onCallUserId !== undefined ? { onCallUserId: input.onCallUserId } : {}),
          },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Team',
          entityId: id,
          entityLabel: row.nameEn,
          before: auditFields(before),
          after: auditFields(row),
        });
        return loadTeam(tx, id);
      });
    },

    archive: (ctx, id, body) => setActive(ctx, id, body, false),
    restore: (ctx, id, body) => setActive(ctx, id, body, true),

    async reorder(ctx, body) {
      requireTeamSettings(ctx.actor);
      await writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit }) => {
        const change = await applyReorder(tx, {
          list: 'Team',
          body,
          currentIds: async () =>
            (
              await tx.team.findMany({
                where: { isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
                select: { id: true },
              })
            ).map((t) => t.id),
          write: (ids) => writeSortOrder(tx, 'Team', ids),
        });
        if (change) {
          await audit.record({
            action: 'REORDER',
            entity: 'Team',
            entityId: 'teams',
            entityLabel: 'Teams',
            before: { order: change.before },
            after: { order: change.after },
          });
        }
      });
    },

    async addMember(ctx, teamId, input) {
      requireMemberChange(ctx.actor, teamId, input.memberRole);
      return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit, after }) => {
        await advisoryLock(tx, `team-members:${teamId}`);
        const team = await tx.team.findUnique({
          where: { id: teamId },
          select: { id: true, nameEn: true, isActive: true },
        });
        if (!team) throw errors.notFound('Team not found');
        if (!team.isActive) {
          throw adminErrors.guard(
            TEAM_GUARDS.archived,
            'This team is archived. Restore it before adding members.',
          );
        }
        const user = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true, name: true, role: true, status: true },
        });
        if (!user || user.status !== 'ACTIVE' || !isStaffRole(user.role)) {
          throw errors.validation([issue(['userId'], 'validation.activeStaff', 'active_staff')]);
        }
        const existing = await memberRow(tx, teamId, user.id);
        if (existing) throw adminErrors.duplicate(['userId']);
        await tx.teamMember.create({
          data: { teamId, userId: user.id, role: input.memberRole },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'TeamMember',
          entityId: `${teamId}:${user.id}`,
          entityLabel: `${user.name} · ${team.nameEn}`,
          after: { teamId, userId: user.id, memberRole: input.memberRole },
        });
        after.invalidatePrincipal(user.id);
        const row = await memberRow(tx, teamId, user.id);
        return toTeamMemberDto(row!);
      });
    },

    async updateMember(ctx, teamId, userId, input) {
      requireTeamAccess(ctx.actor, teamId);
      requireMemberRoleChange(ctx.actor);
      return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit, after }) => {
        // TeamMember has no updatedAt: a role change is checked against the team's, and moves
        // it (E19).
        const current = await lockFresh(tx, 'Team', teamId, input.expectedUpdatedAt);
        await advisoryLock(tx, `team-members:${teamId}`);
        const before = await memberRow(tx, teamId, userId);
        if (!before) throw errors.notFound('Member not found');
        if (before.role === input.memberRole) {
          return { item: toTeamMemberDto(before), teamUpdatedAt: current.toISOString() };
        }
        await tx.teamMember.update({
          where: { teamId_userId: { teamId, userId } },
          data: { role: input.memberRole },
        });
        const team = await tx.team.update({
          where: { id: teamId },
          data: { updatedAt: new Date() },
          select: { nameEn: true, updatedAt: true },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'TeamMember',
          entityId: `${teamId}:${userId}`,
          entityLabel: `${before.user.name} · ${team.nameEn}`,
          before: { memberRole: before.role },
          after: { memberRole: input.memberRole },
        });
        after.invalidatePrincipal(userId);
        const row = await memberRow(tx, teamId, userId);
        return { item: toTeamMemberDto(row!), teamUpdatedAt: team.updatedAt.toISOString() };
      });
    },

    async removeMember(ctx, teamId, userId) {
      requireTeamAccess(ctx.actor, teamId);
      return writer.write(ctx, { scopes: 'teams' }, async ({ tx, audit, after }) => {
        await advisoryLock(tx, `team-members:${teamId}`);
        const before = await memberRow(tx, teamId, userId);
        if (!before) throw errors.notFound('Member not found');
        // A LEAD row is super admin only (checked on the row as stored, not on what the caller says).
        requireMemberChange(ctx.actor, teamId, before.role);
        const team = await tx.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { nameEn: true, onCallUserId: true },
        });
        if (team.onCallUserId === userId) {
          throw adminErrors.guard(
            TEAM_GUARDS.onCallMember,
            'This member is the team’s on-call contact. Choose another on-call user first.',
          );
        }
        await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });
        await audit.record({
          action: 'DELETE',
          entity: 'TeamMember',
          entityId: `${teamId}:${userId}`,
          entityLabel: `${before.user.name} · ${team.nameEn}`,
          before: { teamId, userId, memberRole: before.role },
        });
        after.invalidatePrincipal(userId);
        return toTeamMemberDto(before);
      });
    },
  };
}
