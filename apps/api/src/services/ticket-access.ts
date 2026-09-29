import type { Prisma, PrismaClient } from '@loons/db';
import {
  canViewTicket,
  isActive,
  isStaff,
  parseTicketNumber,
  type Actor,
  type MessageDto,
  type TicketScope,
  type TicketStatus,
  type TicketSummaryDto,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../lib/errors.ts';

// Loading tickets the caller may see (anything else is 404, never 403: existence is not
// revealed), row locks for state changes, and the realtime side of ticket changes.

export type Tx = Prisma.TransactionClient;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ticketScopeSelect = {
  id: true,
  number: true,
  orgId: true,
  teamId: true,
  assigneeId: true,
  status: true,
} as const satisfies Prisma.TicketSelect;

export type TicketScopeRow = Prisma.TicketGetPayload<{ select: typeof ticketScopeSelect }>;

/** `where` for a ticket reference: its uuid, or "LG-4817" / "4817". Null when unparseable. */
export function ticketRefWhere(ref: string): Prisma.TicketWhereUniqueInput | null {
  const value = ref.trim();
  if (UUID_RE.test(value)) return { id: value.toLowerCase() };
  const number = parseTicketNumber(value);
  return number !== null && number <= 2_147_483_647 ? { number } : null;
}

/** The ticket if the caller may see it; otherwise 404 NOT_FOUND (also for unknown refs). */
export async function loadVisibleTicket(
  db: PrismaClient | Tx,
  actor: Actor,
  ref: string,
): Promise<TicketScopeRow> {
  const where = ticketRefWhere(ref);
  const ticket = where ? await db.ticket.findUnique({ where, select: ticketScopeSelect }) : null;
  if (!ticket || !canViewTicket(actor, ticket)) throw errors.notFound('Ticket not found');
  return ticket;
}

/** Prisma twin of `canViewTicket` (and of `visibleSql` in ticket-query.ts). */
export function visibleWhere(actor: Actor): Prisma.TicketWhereInput {
  if (!isActive(actor)) return { id: { in: [] } };
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return {};
    case 'AGENT':
    case 'TEAM_LEAD':
      return { OR: [{ teamId: { in: [...actor.teamIds] } }, { assigneeId: actor.id }] };
    case 'CLIENT':
      return actor.orgId ? { orgId: actor.orgId } : { id: { in: [] } };
  }
}

/** Serialises concurrent changes to one ticket (status machine, SLA clocks, assignment). */
export async function lockTicket(tx: Tx, ticketId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Ticket" WHERE "id" = ${ticketId}::uuid FOR UPDATE`;
}

/**
 * Clients of a deactivated organisation keep read access to their history but can no longer
 * raise tickets, post, upload or change a ticket's status (review SEC-API-3; the same rule that
 * keeps staff from raising tickets for them, `REQUESTER_WHERE`). Staff are not affected.
 */
export async function assertClientCanWrite(db: PrismaClient | Tx, actor: Actor): Promise<void> {
  if (actor.role !== 'CLIENT') return;
  const org = actor.orgId
    ? await db.organization.findUnique({ where: { id: actor.orgId }, select: { isActive: true } })
    : null;
  if (!org?.isActive) throw errors.forbidden('Your organisation’s support contract is not active');
}

/** Only staff reach staff-only endpoints (requesters, macros, teams). */
export function requireStaff(actor: Actor): void {
  if (!isStaff(actor)) throw errors.forbidden('This is only available to Loons staff');
}

export function bodyIssue(
  path: ValidationIssue['path'],
  code: string,
  message = 'validation.invalid',
): ValidationIssue {
  return { location: 'body', path, message, code };
}

/** Terminal state: no replies or edits (the client raises a new ticket). */
export function isClosed(status: TicketStatus): boolean {
  return status === 'CLOSED';
}

/** Realtime side of ticket changes; every call happens after the database commit. */
export interface TicketRealtime {
  /** PUBLIC / SYSTEM → ticket:{id}; INTERNAL → ticket:{id}:staff only. */
  messageNew(message: MessageDto): void;
  /**
   * ticket:{id} (clients and staff viewing the ticket). First removes — on every API instance —
   * the sockets whose user can no longer see the ticket (re-route, unassignment), so they never
   * get this update or anything published after it resolves; waits for the other instances at
   * most about a second (realtime/tickets.ts). `previous`: the ticket's team / assignee before
   * the change, when they may have changed — the users it locked out are removed everywhere
   * without waiting for any other instance.
   */
  ticketUpdated(ticket: TicketSummaryDto, previous?: TicketScope): Promise<void> | void;
  /** team:{id} for every given team (old and new team when re-routed). */
  queueUpdated(
    teamIds: readonly string[],
    ticketId: string,
    reason: 'created' | 'updated' | 'message',
  ): void;
}

/** A no-op implementation (e.g. services used outside the HTTP server). */
export const noopTicketRealtime: TicketRealtime = {
  messageNew: () => undefined,
  ticketUpdated: () => undefined,
  queueUpdated: () => undefined,
};
