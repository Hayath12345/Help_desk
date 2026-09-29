// Ticket rules shared by the API (enforcement) and the web app (display, optimistic updates).
// Spec §7: NEW → OPEN (first agent touch) → PENDING (waiting on client) ↔ OPEN → SOLVED → CLOSED
// (auto after N days solved). A client reply on SOLVED reopens; PENDING pauses the resolution clock.

import type { Priority, TicketStatus } from './enums.ts';

/** Statuses that still need work (and count towards queues and SLA). */
export const ACTIVE_STATUSES = [
  'NEW',
  'OPEN',
  'PENDING',
] as const satisfies readonly TicketStatus[];
export const DONE_STATUSES = ['SOLVED', 'CLOSED'] as const satisfies readonly TicketStatus[];

export function isActiveStatus(status: TicketStatus): boolean {
  return (ACTIVE_STATUSES as readonly TicketStatus[]).includes(status);
}

/** Statuses staff may set by hand in the console (CLOSED is only set by the auto-close job). */
export const STAFF_SETTABLE_STATUSES = [
  'NEW',
  'OPEN',
  'PENDING',
  'SOLVED',
] as const satisfies readonly TicketStatus[];

/** Client portal actions: mark an active ticket solved, or reopen a solved one. */
export function clientCanSetStatus(from: TicketStatus, to: TicketStatus): boolean {
  if (to === 'SOLVED') return isActiveStatus(from);
  if (to === 'OPEN') return from === 'SOLVED';
  return false;
}

export function staffCanSetStatus(from: TicketStatus, to: TicketStatus): boolean {
  if (from === 'CLOSED') return false; // closed tickets are final; the client raises a new one
  return (STAFF_SETTABLE_STATUSES as readonly TicketStatus[]).includes(to) && from !== to;
}

/** Status after a message is posted. `null` = unchanged. */
export function statusAfterMessage(input: {
  current: TicketStatus;
  author: 'client' | 'staff';
  type: 'PUBLIC' | 'INTERNAL';
  andSolve?: boolean;
}): TicketStatus | null {
  const { current, author, type, andSolve } = input;
  if (current === 'CLOSED') return null; // replies to closed tickets are rejected before this
  if (author === 'client') {
    // Client replies put the ticket back in the agents' court (and reopen solved tickets).
    return current === 'OPEN' || current === 'NEW' ? null : 'OPEN';
  }
  if (type === 'INTERNAL') return current === 'NEW' ? 'OPEN' : null; // first touch only
  if (andSolve) return 'SOLVED';
  return current === 'PENDING' ? null : 'PENDING'; // waiting on the client
}

// ───────────── Console views (design: Views column) ─────────────

export const STAFF_VIEWS = ['mine', 'unassigned', 'risk', 'p1', 'open', 'solved'] as const;
export type StaffView = (typeof STAFF_VIEWS)[number];

/** Client "My tickets" tabs. */
export const CLIENT_TABS = ['all', 'active', 'solved'] as const;
export type ClientTab = (typeof CLIENT_TABS)[number];

export const TICKET_SORTS = ['sla', 'recent'] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];

// ───────────── SLA display state ─────────────

export interface SlaFields {
  status: TicketStatus;
  priority: Priority;
  createdAt: string | Date;
  firstReplyDueAt: string | Date | null;
  resolveDueAt: string | Date | null;
  firstRepliedAt: string | Date | null;
  slaPausedAt: string | Date | null;
  slaBreached: boolean;
}

/** A countdown towards one SLA target. */
export interface SlaClock {
  /** Negative once the target has passed. */
  remainingMs: number;
  /** Full window length, for the progress bar. */
  windowMs: number;
  overdue: boolean;
  /** Design rule: less than min(1 h, 50% of the window) left (and not yet overdue). */
  atRisk: boolean;
}

export type SlaState =
  | { kind: 'done' } // SOLVED / CLOSED
  /** PENDING after the first reply (or without a first-reply target): nothing is running. */
  | { kind: 'paused' }
  /**
   * First reply not sent yet: the list shows this countdown. It keeps running while the ticket
   * is PENDING (spec §7: PENDING only pauses the resolution clock); `resolutionPaused` says so
   * and `resolution` is then null.
   */
  | { kind: 'firstReply'; clock: SlaClock; resolution: SlaClock | null; resolutionPaused?: true }
  /** First reply sent: the list shows "Replied"; the SLA card shows the resolution clock. */
  | { kind: 'replied'; resolution: SlaClock | null };

const toMs = (d: string | Date | null): number | null =>
  d === null ? null : typeof d === 'string' ? Date.parse(d) : d.getTime();

function clock(startMs: number, dueMs: number | null, now: number): SlaClock | null {
  if (dueMs === null) return null;
  const remainingMs = dueMs - now;
  const windowMs = Math.max(1, dueMs - startMs);
  const overdue = remainingMs < 0;
  return {
    remainingMs,
    windowMs,
    overdue,
    atRisk: !overdue && remainingMs < Math.min(60 * 60_000, windowMs * 0.5),
  };
}

/**
 * What the SLA countdowns show (list rows, the right-panel SLA card, the "SLA at risk" view).
 * Due dates are computed by the API (business hours, holidays, pauses); this only compares them
 * with `now`. PENDING pauses the resolution clock only: an unanswered PENDING ticket keeps its
 * first-reply countdown (the API's SQL twins — `atRiskSql` and the `sla` sort — agree).
 */
export function slaState(t: SlaFields, now: number = Date.now()): SlaState {
  if (t.status === 'SOLVED' || t.status === 'CLOSED') return { kind: 'done' };
  const pending = t.status === 'PENDING';
  const created = toMs(t.createdAt) ?? now;
  if (t.firstRepliedAt === null) {
    const first = clock(created, toMs(t.firstReplyDueAt), now);
    if (first) {
      return pending
        ? { kind: 'firstReply', clock: first, resolution: null, resolutionPaused: true }
        : {
            kind: 'firstReply',
            clock: first,
            resolution: clock(created, toMs(t.resolveDueAt), now),
          };
    }
  }
  if (pending) return { kind: 'paused' };
  return { kind: 'replied', resolution: clock(created, toMs(t.resolveDueAt), now) };
}

/**
 * "SLA at risk" view membership: first reply at risk or overdue (also while PENDING), or the
 * running resolution clock at risk/overdue.
 */
export function isSlaAtRiskOrBreached(t: SlaFields, now: number = Date.now()): boolean {
  const s = slaState(t, now);
  if (s.kind === 'firstReply') return s.clock.atRisk || s.clock.overdue;
  if (s.kind === 'replied') return !!s.resolution && (s.resolution.atRisk || s.resolution.overdue);
  return false;
}
