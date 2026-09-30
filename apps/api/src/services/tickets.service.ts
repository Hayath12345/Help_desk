import type { Prisma, PrismaClient } from '@loons/db';
import {
  STAFF_ROLES,
  canAcknowledgeP1,
  canCreateTicketForOrg,
  canMarkSolved,
  canSeeInternalNotes,
  canUpdateTicket,
  clientCanSetStatus,
  isStaff,
  isSuperAdmin,
  staffCanSetStatus,
  type Actor,
  type BusinessCalendar,
  type CreateTicketInput,
  type ListTicketsQuery,
  type Priority,
  type AcknowledgeTicketResponse,
  type TicketCounts,
  type TicketDetailDto,
  type TicketFormConfig,
  type TicketList,
  type TicketSummaryDto,
  type UpdateTicketInput,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../lib/errors.ts';
import { loadP1Chain } from '../lib/escalation.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import { attachmentLinkIssues, linkAttachments } from './attachments.service.ts';
import { customFieldValueOptions, validateCustomFields } from './custom-fields.ts';
import type { Notifier } from './notifier.ts';
import { REQUESTER_WHERE } from './directory.service.ts';
import type { SlaMath } from './sla.ts';
import {
  assertClientCanWrite,
  bodyIssue,
  isClosed,
  loadVisibleTicket,
  lockTicket,
  visibleWhere,
  type TicketRealtime,
  type Tx,
} from './ticket-access.ts';
import type { TicketConfigService } from './ticket-config.service.ts';
import {
  VISIBLE_ATTACHMENT_STATUSES,
  attachmentSelect,
  ticketDetailSelect,
  ticketSummarySelect,
  toAttachmentDto,
  summaryOf,
  toSummaryDto,
} from './ticket-dto.ts';
import {
  activeCountsByTeam,
  clientTabCounts,
  listTicketIds,
  staffViewCounts,
} from './ticket-query.ts';
import { slaPausesOf, statusChangeData } from './ticket-state.ts';

// Tickets (spec §7): create against the live config, list / count / read within the caller's
// visibility, and update with one TicketEvent per changed field. Realtime events go out only
// after the transaction has committed.

/** Tag added to every SECURITY_INCIDENT ticket. */
export const SECURITY_TAG = 'security';

type EventInput = Omit<Prisma.TicketEventCreateManyInput, 'ticketId'>;

export interface TicketsService {
  create(actor: Actor, input: CreateTicketInput): Promise<TicketDetailDto>;
  list(actor: Actor, query: ListTicketsQuery): Promise<TicketList>;
  counts(actor: Actor): Promise<TicketCounts>;
  /** By uuid or LG number; 404 when the caller can't see it. */
  get(actor: Actor, ref: string): Promise<TicketDetailDto>;
  update(actor: Actor, ticketId: string, input: UpdateTicketInput): Promise<TicketDetailDto>;
  /**
   * Acknowledges a P1 (staff who can see it, D5). Idempotent: a second call changes nothing and
   * answers with the first acknowledger (`alreadyAcknowledged: true`). Not a P1 / closed ⇒ 409.
   */
  acknowledge(actor: Actor, ticketId: string): Promise<AcknowledgeTicketResponse>;
  /** Summary DTO (no visibility check: callers have checked it already). */
  summary(ticketId: string): Promise<TicketSummaryDto>;
}

/** Tag ids for `keys`, creating missing Tag rows (label = key). */
export async function ensureTags(tx: Tx, keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  await tx.tag.createMany({
    data: keys.map((key) => ({ key, label: key })),
    skipDuplicates: true,
  });
  const rows = await tx.tag.findMany({
    where: { key: { in: [...keys] } },
    select: { id: true, key: true },
  });
  return new Map(rows.map((r) => [r.key, r.id]));
}

function policyFor(config: TicketFormConfig, priority: Priority) {
  const policy = config.slaPolicies.find((p) => p.priority === priority);
  if (!policy) throw new Error(`No SLA policy is configured for ${priority}`);
  return policy;
}

/** JSON with object keys sorted (jsonb does not keep key order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : v,
  );
}

/** Keys whose value differs between two custom-field objects (added, changed or removed), sorted. */
export function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))
    .sort();
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createTicketsService(deps: {
  prisma: PrismaClient;
  ticketConfig: TicketConfigService;
  sla: SlaMath;
  realtime: TicketRealtime;
  /** Notification producers, called after each commit (D15). */
  notifier: Notifier;
  logger: Logger;
}): TicketsService {
  const { prisma, ticketConfig, sla, realtime, notifier, logger } = deps;

  /** Realtime failures never fail a request whose changes have committed. */
  function emit(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      logger.error({ err, event: what }, 'realtime emit failed');
    }
  }

  /** Same for emits that first evict sockets (awaited, so later events can't overtake them). */
  async function emitAsync(what: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, event: what }, 'realtime emit failed');
    }
  }

  async function summary(ticketId: string): Promise<TicketSummaryDto> {
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: ticketSummarySelect,
    });
    return toSummaryDto(row);
  }

  async function detail(actor: Actor, ticketId: string): Promise<TicketDetailDto> {
    const staffView = canSeeInternalNotes(actor);
    const row = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: ticketDetailSelect,
    });
    const values = jsonObject(row.customFields);
    const keys = Object.keys(values);
    const [config, attachments, fields, links, sitesCount, otherTicketsCount, chain] =
      await Promise.all([
        ticketConfig.getFormConfig(),
        prisma.attachment.findMany({
          where: {
            ticketId,
            status: { in: [...VISIBLE_ATTACHMENT_STATUSES] },
            messageId: { not: null },
            // Files of internal notes are staff-only.
            ...(staffView ? {} : { message: { type: { not: 'INTERNAL' } } }),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: attachmentSelect,
        }),
        keys.length
          ? prisma.customField.findMany({
              where: { key: { in: keys } },
              select: {
                id: true,
                key: true,
                labelEn: true,
                labelAr: true,
                type: true,
                isActive: true,
                options: true,
              },
            })
          : Promise.resolve([]),
        keys.length
          ? prisma.categoryField.findMany({
              where: { categoryId: row.categoryId },
              select: { fieldId: true, sortOrder: true },
            })
          : Promise.resolve([]),
        prisma.site.count({ where: { orgId: row.orgId, isActive: true } }),
        staffView
          ? prisma.ticket.count({
              where: { AND: [visibleWhere(actor), { orgId: row.orgId, id: { not: row.id } }] },
            })
          : Promise.resolve(0),
        // The P1 banner's "step N of M · next at …" (staff only; D3 team rules replace global).
        staffView ? loadP1Chain(prisma, row.teamId) : Promise.resolve(null),
      ]);
    const order = new Map(links.map((l) => [l.fieldId, l.sortOrder]));
    const customFields = fields
      .slice()
      .sort(
        (a, b) =>
          (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key),
      )
      .map((f) => ({
        key: f.key,
        labelEn: f.labelEn,
        labelAr: f.labelAr,
        type: f.type,
        value: values[f.key],
        isActive: f.isActive,
        options: customFieldValueOptions(f.type, f.options, values[f.key]),
      }));
    const { accountManager, contractType, amcExpiry } = row.org;
    return {
      ...toSummaryDto(row),
      description: row.description,
      assetId: row.assetId,
      customFields,
      attachments: attachments.map(toAttachmentDto),
      requesterCard: {
        org: {
          id: row.org.id,
          name: row.org.name,
          nameAr: row.org.nameAr,
          contractType,
          amcExpiry: amcExpiry ? amcExpiry.toISOString().slice(0, 10) : null,
        },
        accountManager,
        sitesCount,
        otherTicketsCount,
      },
      sla: policyFor(config, row.priority),
      p1Chain: chain ? chain.map((r) => ({ step: r.step, afterMins: r.afterMins })) : null,
    };
  }

  // ───────────── Create ─────────────

  async function create(actor: Actor, input: CreateTicketInput): Promise<TicketDetailDto> {
    const staff = isStaff(actor);
    const config = await ticketConfig.getFormConfig();
    const issues: ValidationIssue[] = [];

    const category = config.categories.find((c) => c.id === input.categoryId);
    if (!category) issues.push(bodyIssue(['categoryId'], 'category'));
    const subtype = category?.subtypes.find((s) => s.id === input.subtypeId);
    if (category && !subtype) issues.push(bodyIssue(['subtypeId'], 'subtype'));
    // Spec §7: a Security Incident is always raised under Cybersecurity / SOC.
    if (
      category &&
      input.type === 'SECURITY_INCIDENT' &&
      category.key !== config.securityCategoryKey
    ) {
      issues.push(bodyIssue(['categoryId'], 'security_category'));
    }
    let customFields: Record<string, unknown> = {};
    if (category) {
      const schema = ticketConfig.customFieldsSchema(config, category.id);
      const result = schema
        ? validateCustomFields(schema, input.customFields)
        : { ok: true as const, value: {} };
      if (result.ok) customFields = result.value;
      else issues.push(...result.issues);
    }

    // Who the ticket is for.
    let requester: { id: string; orgId: string } | null = null;
    if (staff) {
      if (!input.requesterId) {
        issues.push(bodyIssue(['requesterId'], 'required', 'validation.required'));
      } else {
        const user = await prisma.user.findFirst({
          where: { id: input.requesterId, ...REQUESTER_WHERE },
          select: { id: true, orgId: true },
        });
        if (user?.orgId) requester = { id: user.id, orgId: user.orgId };
        else issues.push(bodyIssue(['requesterId'], 'requester'));
      }
    } else {
      if (input.requesterId && input.requesterId !== actor.id) {
        throw errors.forbidden('Clients raise tickets for themselves');
      }
      await assertClientCanWrite(prisma, actor);
      if (actor.orgId) requester = { id: actor.id, orgId: actor.orgId };
    }
    if (!requester) {
      if (issues.length) throw errors.validation(issues);
      throw errors.forbidden();
    }
    if (!canCreateTicketForOrg(actor, requester.orgId)) throw errors.forbidden();

    const site = await prisma.site.findFirst({
      where: { id: input.siteId, orgId: requester.orgId, isActive: true },
      select: { id: true },
    });
    if (!site) issues.push(bodyIssue(['siteId'], 'site'));
    issues.push(
      ...(await attachmentLinkIssues(prisma, actor, input.attachmentIds, null, 'PUBLIC')),
    );
    if (issues.length || !category || !subtype || !site) throw errors.validation(issues);

    const priority = input.priority ?? subtype.defaultPriority;
    const createdAt = new Date();
    // Due dates and at-risk instants (D1/D2) are stored together.
    const due = sla.computeSlaTargets(
      createdAt,
      policyFor(config, priority),
      await ticketConfig.getCalendar(),
    );
    const teamId = category.team.id;
    const assigneeId = staff && actor.teamIds.includes(teamId) ? actor.id : null;
    const status = staff ? 'OPEN' : 'NEW';
    const channel = staff ? 'PHONE' : 'PORTAL';
    const tags = input.type === 'SECURITY_INCIDENT' ? [SECURITY_TAG] : [];
    const requesterId = requester.id;
    const orgId = requester.orgId;

    const ticketId = await prisma.$transaction(async (tx) => {
      const tagIds = await ensureTags(tx, tags);
      const ticket = await tx.ticket.create({
        data: {
          type: input.type,
          subject: input.subject,
          description: input.description,
          categoryId: category.id,
          subtypeId: subtype.id,
          priority,
          impact: input.impact,
          status,
          channel,
          orgId,
          siteId: site.id,
          assetId: input.assetId ? input.assetId : null,
          requesterId,
          assigneeId,
          teamId,
          customFields: customFields as Prisma.InputJsonObject,
          firstReplyDueAt: due.firstReplyDueAt,
          resolveDueAt: due.resolveDueAt,
          firstReplyAtRiskAt: due.firstReplyAtRiskAt,
          resolveAtRiskAt: due.resolveAtRiskAt,
          // A P1 period starts at creation (the escalation chain counts from here, D3).
          p1Since: priority === 'P1' ? createdAt : null,
          lastMessageAt: createdAt,
          createdAt,
          tags: { create: [...tagIds.values()].map((tagId) => ({ tagId })) },
        },
        select: { id: true },
      });
      // The description is the first public message (author: the client, or the staff member
      // who raised the ticket on their behalf).
      const message = await tx.message.create({
        data: {
          ticketId: ticket.id,
          authorId: staff ? actor.id : requesterId,
          type: 'PUBLIC',
          body: input.description,
          createdAt,
        },
        select: { id: true },
      });
      await linkAttachments(tx, actor, input.attachmentIds, ticket.id, message.id, 'PUBLIC');
      const events: EventInput[] = [
        {
          type: 'CREATED',
          actorId: actor.id,
          fromValue: null,
          toValue: status,
          meta: {
            priority,
            type: input.type,
            category: category.key,
            subtype: subtype.key,
            channel,
          },
          createdAt,
        },
      ];
      if (assigneeId) {
        events.push({
          type: 'ASSIGNEE_CHANGED',
          actorId: actor.id,
          fromValue: null,
          toValue: assigneeId,
          createdAt,
        });
      }
      await tx.ticketEvent.createMany({
        data: events.map((e) => ({ ...e, ticketId: ticket.id })),
      });
      return ticket.id;
    });

    const result = await detail(actor, ticketId);
    emit('queue:updated', () => realtime.queueUpdated([teamId], ticketId, 'created'));
    await notifier.ticketCreated({
      id: ticketId,
      teamId,
      p1Since: priority === 'P1' ? createdAt : null,
    });
    return result;
  }

  // ───────────── Update ─────────────

  async function update(
    actor: Actor,
    ticketId: string,
    input: UpdateTicketInput,
  ): Promise<TicketDetailDto> {
    const scope = await loadVisibleTicket(prisma, actor, ticketId);
    const staff = isStaff(actor);
    const requested = (Object.keys(input) as Array<keyof UpdateTicketInput>).filter(
      (k) => input[k] !== undefined,
    );
    if (staff) {
      if (!canUpdateTicket(actor, scope)) throw errors.notFound('Ticket not found');
    } else if (requested.some((k) => k !== 'status') || !canMarkSolved(actor, scope)) {
      throw errors.forbidden('Clients can only mark a ticket solved or reopen it');
    } else {
      await assertClientCanWrite(prisma, actor);
    }

    const config = await ticketConfig.getFormConfig();
    let calendar: BusinessCalendar | null = null;
    const getCalendar = async () => (calendar ??= await ticketConfig.getCalendar());

    const outcome = await prisma.$transaction(async (tx) => {
      await lockTicket(tx, scope.id);
      const t = await tx.ticket.findUniqueOrThrow({
        where: { id: scope.id },
        select: {
          id: true,
          type: true,
          status: true,
          priority: true,
          categoryId: true,
          subtypeId: true,
          teamId: true,
          orgId: true,
          assigneeId: true,
          impact: true,
          siteId: true,
          assetId: true,
          customFields: true,
          createdAt: true,
          firstRepliedAt: true,
          firstReplyDueAt: true,
          resolveDueAt: true,
          firstReplyAtRiskAt: true,
          resolveAtRiskAt: true,
          slaPausedAt: true,
          slaPauses: true,
          p1Since: true,
          tags: { select: { tag: { select: { key: true } } } },
        },
      });
      const now = new Date();
      const issues: ValidationIssue[] = [];
      const data: Prisma.TicketUncheckedUpdateInput = {};
      const events: EventInput[] = [];
      const event = (
        type: EventInput['type'],
        from: string | null,
        to: string | null,
        meta?: object,
      ) =>
        events.push({
          type,
          actorId: actor.id,
          fromValue: from,
          toValue: to,
          ...(meta ? { meta: meta as Prisma.InputJsonObject } : {}),
          createdAt: now,
        });

      // Category / sub-type (re-routes to the category's team).
      let categoryId = t.categoryId;
      let teamId = t.teamId;
      if (input.categoryId !== undefined && input.categoryId !== t.categoryId) {
        const category = config.categories.find((c) => c.id === input.categoryId);
        if (!category) {
          issues.push(bodyIssue(['categoryId'], 'category'));
        } else {
          if (t.type === 'SECURITY_INCIDENT' && category.key !== config.securityCategoryKey) {
            issues.push(bodyIssue(['categoryId'], 'security_category'));
          }
          const subtype = input.subtypeId
            ? category.subtypes.find((s) => s.id === input.subtypeId)
            : undefined;
          if (!input.subtypeId) {
            issues.push(bodyIssue(['subtypeId'], 'required', 'validation.required'));
          } else if (!subtype) {
            issues.push(bodyIssue(['subtypeId'], 'subtype'));
          } else {
            categoryId = category.id;
            teamId = category.team.id;
            data.categoryId = category.id;
            event('CATEGORY_CHANGED', t.categoryId, category.id);
            if (subtype.id !== t.subtypeId) {
              data.subtypeId = subtype.id;
              event('SUBTYPE_CHANGED', t.subtypeId, subtype.id);
            }
            if (teamId !== t.teamId) {
              data.teamId = teamId;
              event('TEAM_CHANGED', t.teamId, teamId);
            }
          }
        }
      } else if (input.subtypeId !== undefined && input.subtypeId !== t.subtypeId) {
        const category = config.categories.find((c) => c.id === t.categoryId);
        const subtype = category?.subtypes.find((s) => s.id === input.subtypeId);
        if (!subtype) {
          issues.push(bodyIssue(['subtypeId'], 'subtype'));
        } else {
          data.subtypeId = subtype.id;
          event('SUBTYPE_CHANGED', t.subtypeId, subtype.id);
        }
      }

      // Priority: SLA targets (due dates and at-risk instants) recomputed from createdAt with the
      // new policy, replaying the finished PENDING pauses (time spent waiting on the client stays
      // credited; a pause still running is credited when it ends). A first reply already sent
      // keeps its due date and at-risk instant.
      let priority = t.priority;
      let p1Since = t.p1Since;
      let resolveDueAt = t.resolveDueAt;
      let resolveAtRiskAt = t.resolveAtRiskAt;
      if (input.priority !== undefined && input.priority !== t.priority) {
        priority = input.priority;
        const due = sla.computeSlaTargets(
          t.createdAt,
          policyFor(config, priority),
          await getCalendar(),
          slaPausesOf(t.slaPauses),
        );
        data.priority = priority;
        if (!t.firstRepliedAt) {
          data.firstReplyDueAt = due.firstReplyDueAt;
          data.firstReplyAtRiskAt = due.firstReplyAtRiskAt;
        }
        data.resolveDueAt = resolveDueAt = due.resolveDueAt;
        data.resolveAtRiskAt = resolveAtRiskAt = due.resolveAtRiskAt;
        // A crossing the new targets put in the past is announced as fresh from now (D10).
        data.slaTargetsChangedAt = now;
        // Becoming P1 starts a new P1 period (the escalation chain counts from now, D3); leaving
        // P1 ends it. Either way the escalation progress and the acknowledgement start over.
        if ((priority === 'P1') !== (t.priority === 'P1')) {
          data.p1Since = p1Since = priority === 'P1' ? now : null;
          data.p1EscalationStep = 0;
          data.p1AckedAt = null;
          data.p1AckedById = null;
        }
        event('PRIORITY_CHANGED', t.priority, priority);
      }

      // Status.
      if (input.status !== undefined && input.status !== t.status) {
        const allowed = staff
          ? staffCanSetStatus(t.status, input.status)
          : clientCanSetStatus(t.status, input.status);
        if (!allowed) {
          throw errors.conflict(`The status can't change from ${t.status} to ${input.status}`);
        }
        Object.assign(
          data,
          await statusChangeData({
            from: t.status,
            to: input.status,
            now,
            resolveDueAt,
            resolveAtRiskAt,
            slaPausedAt: t.slaPausedAt,
            slaPauses: t.slaPauses,
            businessHoursOnly: policyFor(config, priority).businessHoursOnly,
            calendar: getCalendar,
            math: sla,
          }),
        );
        event('STATUS_CHANGED', t.status, input.status);
      }

      // Assignee: active staff on the ticket's (new) team, or a super admin; null unassigns.
      if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
        if (input.assigneeId === null) {
          data.assigneeId = null;
          event('ASSIGNEE_CHANGED', t.assigneeId, null);
        } else {
          const assignee = await tx.user.findFirst({
            where: {
              id: input.assigneeId,
              status: 'ACTIVE',
              OR: [
                { role: 'SUPER_ADMIN' },
                {
                  role: { in: STAFF_ROLES.filter((r) => r !== 'SUPER_ADMIN') },
                  teamMemberships: { some: { teamId } },
                },
              ],
            },
            select: { id: true },
          });
          if (!assignee) {
            issues.push(bodyIssue(['assigneeId'], 'assignee'));
          } else {
            data.assigneeId = assignee.id;
            event('ASSIGNEE_CHANGED', t.assigneeId, assignee.id);
          }
        }
      } else if (teamId !== t.teamId && t.assigneeId) {
        // Re-routed: an assignee who isn't on the new team hands the ticket to that team's queue.
        const stays = await tx.user.findFirst({
          where: {
            id: t.assigneeId,
            status: 'ACTIVE',
            OR: [{ role: 'SUPER_ADMIN' }, { teamMemberships: { some: { teamId } } }],
          },
          select: { id: true },
        });
        if (!stays) {
          data.assigneeId = null;
          event('ASSIGNEE_CHANGED', t.assigneeId, null);
        }
      }

      if (input.impact !== undefined && input.impact !== t.impact) {
        data.impact = input.impact;
        event('IMPACT_CHANGED', t.impact, input.impact);
      }

      if (input.siteId !== undefined && input.siteId !== t.siteId) {
        const site = await tx.site.findFirst({
          where: { id: input.siteId, orgId: t.orgId, isActive: true },
          select: { id: true },
        });
        if (site) {
          data.siteId = site.id;
          event('SITE_CHANGED', t.siteId, site.id);
        } else {
          issues.push(bodyIssue(['siteId'], 'site'));
        }
      }

      if (input.assetId !== undefined) {
        const assetId = input.assetId ? input.assetId : null;
        if (assetId !== t.assetId) {
          data.assetId = assetId;
          event('ASSET_CHANGED', t.assetId, assetId);
        }
      }

      if (input.customFields !== undefined) {
        const schema = ticketConfig.customFieldsSchema(config, categoryId);
        if (!schema) {
          issues.push(bodyIssue(['categoryId'], 'category'));
        } else {
          const result = validateCustomFields(schema, input.customFields);
          if (!result.ok) issues.push(...result.issues);
          else {
            const fields = changedKeys(jsonObject(t.customFields), result.value);
            if (fields.length) {
              data.customFields = result.value as Prisma.InputJsonObject;
              // Keys only: custom-field values stay on the ticket, not in its history.
              event('CUSTOM_FIELDS_CHANGED', null, null, { fields });
            }
          }
        }
      }

      // Tags: the full new set (missing Tag rows are created by key).
      let tagChange: { added: string[]; removed: string[]; next: string[] } | null = null;
      if (input.tags !== undefined) {
        const current = t.tags.map((x) => x.tag.key).sort();
        const next = [...new Set(input.tags)].sort();
        const added = next.filter((k) => !current.includes(k));
        const removed = current.filter((k) => !next.includes(k));
        if (added.length || removed.length) {
          tagChange = { added, removed, next };
          event(
            'TAGS_CHANGED',
            current.length ? current.join(',') : null,
            next.length ? next.join(',') : null,
            { added, removed },
          );
        }
      }

      if (issues.length) throw errors.validation(issues);
      const changed = Object.keys(data).length > 0 || tagChange !== null;
      const before = { orgId: t.orgId, teamId: t.teamId, assigneeId: t.assigneeId };
      const priorityChange = {
        before: { priority: t.priority, p1Since: t.p1Since },
        after: { priority, p1Since },
      };
      if (!changed) return { changed: false as const, before, teamId: t.teamId, priorityChange };
      if (isClosed(t.status)) throw errors.conflict('This ticket is closed');

      if (tagChange) {
        const ids = await ensureTags(tx, tagChange.added);
        if (tagChange.removed.length) {
          await tx.ticketTag.deleteMany({
            where: { ticketId: t.id, tag: { key: { in: tagChange.removed } } },
          });
        }
        if (ids.size) {
          await tx.ticketTag.createMany({
            data: [...ids.values()].map((tagId) => ({ ticketId: t.id, tagId })),
            skipDuplicates: true,
          });
        }
      }
      // Always touch the row so updatedAt moves (tags live in another table).
      await tx.ticket.update({ where: { id: t.id }, data: { ...data, updatedAt: now } });
      if (events.length) {
        await tx.ticketEvent.createMany({ data: events.map((e) => ({ ...e, ticketId: t.id })) });
      }
      return { changed: true as const, before, teamId, priorityChange };
    });

    const result = await detail(actor, scope.id);
    if (outcome.changed) {
      await emitAsync('ticket:updated', () =>
        realtime.ticketUpdated(summaryOf(result), outcome.before),
      );
      const teams = [...new Set([outcome.before.teamId, outcome.teamId])];
      emit('queue:updated', () => realtime.queueUpdated(teams, scope.id, 'updated'));
      await notifier.priorityChanged({
        id: scope.id,
        teamId: outcome.teamId,
        ...outcome.priorityChange,
      });
    }
    return result;
  }

  // ───────────── P1 acknowledge (D5) ─────────────

  async function acknowledge(actor: Actor, ticketId: string): Promise<AcknowledgeTicketResponse> {
    const scope = await loadVisibleTicket(prisma, actor, ticketId);
    if (!canAcknowledgeP1(actor, scope)) {
      throw errors.forbidden('Only Loons staff can acknowledge a P1 ticket');
    }
    const outcome = await prisma.$transaction(async (tx) => {
      await lockTicket(tx, scope.id);
      const t = await tx.ticket.findUniqueOrThrow({
        where: { id: scope.id },
        select: {
          priority: true,
          status: true,
          p1Since: true,
          p1AckedAt: true,
          p1EscalationStep: true,
        },
      });
      if (t.priority !== 'P1') throw errors.conflict('This ticket is not a P1');
      if (t.p1AckedAt) return { acknowledged: false as const };
      if (isClosed(t.status)) throw errors.conflict('This ticket is closed');
      const now = new Date();
      await tx.ticket.update({
        where: { id: scope.id },
        data: { p1AckedAt: now, p1AckedById: actor.id, updatedAt: now },
      });
      await tx.ticketEvent.create({
        data: {
          ticketId: scope.id,
          type: 'P1_ACKNOWLEDGED',
          actorId: actor.id,
          fromValue: null,
          toValue: actor.id,
          meta: {
            step: t.p1EscalationStep,
            p1Since: t.p1Since ? t.p1Since.toISOString() : null,
            minutesToAcknowledge: t.p1Since
              ? Math.round((now.getTime() - t.p1Since.getTime()) / 60_000)
              : null,
          },
          createdAt: now,
        },
      });
      return { acknowledged: true as const, p1Since: t.p1Since };
    });

    const result = await detail(actor, scope.id);
    if (outcome.acknowledged) {
      await emitAsync('ticket:updated', () => realtime.ticketUpdated(summaryOf(result)));
      emit('queue:updated', () => realtime.queueUpdated([scope.teamId], scope.id, 'updated'));
      await notifier.acknowledged({ id: scope.id, p1Since: outcome.p1Since, actorId: actor.id });
    }
    return { ticket: result, alreadyAcknowledged: !outcome.acknowledged };
  }

  // ───────────── Read ─────────────

  return {
    create,
    update,
    acknowledge,
    summary,

    async get(actor, ref) {
      const ticket = await loadVisibleTicket(prisma, actor, ref);
      return detail(actor, ticket.id);
    },

    async list(actor, query) {
      const { ids, nextCursor } = await listTicketIds(prisma, { actor, query, now: new Date() });
      const rows = ids.length
        ? await prisma.ticket.findMany({ where: { id: { in: ids } }, select: ticketSummarySelect })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const items = ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toSummaryDto(row)] : [];
      });
      return { items, nextCursor };
    },

    async counts(actor) {
      if (!isStaff(actor)) {
        return { kind: 'client', tabs: await clientTabCounts(prisma, actor) };
      }
      const [views, byTeam, teams] = await Promise.all([
        staffViewCounts(prisma, actor, new Date()),
        activeCountsByTeam(prisma, actor),
        prisma.team.findMany({
          where: {
            isActive: true,
            ...(isSuperAdmin(actor) ? {} : { id: { in: [...actor.teamIds] } }),
          },
          orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
          select: { id: true, key: true, nameEn: true, nameAr: true },
        }),
      ]);
      return {
        kind: 'staff',
        views,
        teams: teams.map((team) => ({ ...team, count: byTeam.get(team.id) ?? 0 })),
      };
    },
  };
}
