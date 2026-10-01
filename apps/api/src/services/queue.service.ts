import type { PrismaClient } from '@loons/db';
import {
  AGENT_QUEUE_CAPACITY,
  STAFF_ROLES,
  isSuperAdmin,
  type Actor,
  type BulkFailureReason,
  type BulkTicketOutcome,
  type BulkTicketResult,
  type BulkTicketsInput,
  type QueueCounts,
  type QueueCountsQuery,
  type QueueFilterOptions,
  type UpdateTicketInput,
  type Workload,
} from '@loons/shared';
import { AppError } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import { requireStaff } from './ticket-access.ts';
import { CATEGORY_ADMIN_ORDER, categoryRefSelect } from './ticket-dto.ts';
import { assigneeWorkload, queueTabCounts, visibleSql } from './ticket-query.ts';
import type { TicketsService } from './tickets.service.ts';

// Phase 5 Team queue (decisions F3–F6): tab counts for the list filters, agent workload cards, the
// Category filter's options and bulk actions. Staff only; every number is scoped like the Inbox
// (visibility SQL of ticket-query.ts). Bulk actions go through the single-ticket update one ticket
// at a time: same permissions, TicketEvents, notifications and realtime as PATCH /tickets/:id.

export interface QueueService {
  counts(actor: Actor, query: QueueCountsQuery): Promise<QueueCounts>;
  workload(actor: Actor): Promise<Workload>;
  filterOptions(actor: Actor): Promise<QueueFilterOptions>;
  bulk(actor: Actor, input: BulkTicketsInput): Promise<BulkTicketResult>;
}

/** Why a ticket of a bulk request failed, from the error the single-ticket update threw. */
export function bulkFailureReason(err: unknown): BulkFailureReason {
  if (!(err instanceof AppError)) return 'internal';
  switch (err.statusCode) {
    case 404:
      return 'not_found';
    case 403:
      return 'forbidden';
    case 409:
      return 'conflict';
    case 400:
      return 'invalid';
    default:
      return 'internal';
  }
}

export function createQueueService(deps: {
  prisma: PrismaClient;
  tickets: TicketsService;
  logger: Logger;
  /** Clock (tests). */
  now?: () => Date;
}): QueueService {
  const { prisma, tickets, logger } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async counts(actor, query) {
      requireStaff(actor);
      return { tabs: await queueTabCounts(prisma, actor, query, now()) };
    },

    async workload(actor) {
      requireStaff(actor);
      // Active staff members of the active teams the caller sees (super admins: every team).
      const teams = await prisma.team.findMany({
        where: {
          isActive: true,
          ...(isSuperAdmin(actor) ? {} : { id: { in: [...actor.teamIds] } }),
        },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          key: true,
          nameEn: true,
          nameAr: true,
          members: {
            where: { user: { status: 'ACTIVE', role: { in: [...STAFF_ROLES] } } },
            select: { user: { select: { id: true, name: true } } },
          },
        },
      });
      const agents = new Map<string, Workload['agents'][number]>();
      for (const { members, ...team } of teams) {
        for (const { user } of members) {
          const agent = agents.get(user.id) ?? { ...user, teams: [], open: 0, atRisk: 0 };
          agent.teams.push(team);
          agents.set(user.id, agent);
        }
      }
      const counts = await assigneeWorkload(prisma, actor, [...agents.keys()], now());
      const list = [...agents.values()].map((agent) => ({
        ...agent,
        ...(counts.get(agent.id) ?? { open: 0, atRisk: 0 }),
      }));
      list.sort(
        (a, b) => b.open - a.open || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
      return { capacity: AGENT_QUEUE_CAPACITY, agents: list };
    },

    async filterOptions(actor) {
      requireStaff(actor);
      const [active, archivedIds] = await Promise.all([
        prisma.category.findMany({
          where: { isActive: true },
          orderBy: [...CATEGORY_ADMIN_ORDER],
          select: categoryRefSelect,
        }),
        // Archived categories still offered: those with a ticket the caller can see.
        prisma.$queryRaw<Array<{ id: string }>>`
          SELECT DISTINCT t."categoryId" AS id
          FROM "Ticket" t JOIN "Category" c ON c."id" = t."categoryId"
          WHERE c."isActive" = FALSE AND ${visibleSql(actor)}`,
      ]);
      const archived = archivedIds.length
        ? await prisma.category.findMany({
            where: { id: { in: archivedIds.map((r) => r.id) } },
            orderBy: [...CATEGORY_ADMIN_ORDER],
            select: categoryRefSelect,
          })
        : [];
      return { categories: [...active, ...archived] };
    },

    async bulk(actor, input) {
      requireStaff(actor);
      const change: UpdateTicketInput =
        input.action === 'assignToMe' ? { assigneeId: actor.id } : { status: 'SOLVED' };
      const results: BulkTicketOutcome[] = [];
      // One ticket at a time: each update takes its own row lock and emits its own events.
      for (const id of input.ids) {
        try {
          const { changed } = await tickets.updateTracked(actor, id, change, { openIfNew: true });
          results.push({ id, ok: true, changed });
        } catch (err) {
          const reason = bulkFailureReason(err);
          if (reason === 'internal') {
            logger.error({ err, ticketId: id }, 'bulk ticket update failed');
          }
          results.push({
            id,
            ok: false,
            error: {
              reason,
              message:
                err instanceof AppError && reason !== 'internal'
                  ? err.message
                  : 'Something went wrong. Please try again.',
            },
          });
        }
      }
      const updated = results.filter((r) => r.ok).length;
      return { results, updated, failed: results.length - updated };
    },
  };
}
