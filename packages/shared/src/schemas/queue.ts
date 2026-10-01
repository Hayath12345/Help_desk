// Phase 5 — Team queue (decisions F3–F6): tab counts, agent workload cards, filter options and
// bulk actions. Staff only (clients get 403); every number counts only tickets the caller can see
// (the Inbox visibility: super admins everything, agents and team leads their teams' tickets plus
// tickets assigned to them).
//
// GET  /tickets/queue-counts?<filters>  → QueueCounts (the tabs, for the same filters + search)
// GET  /tickets/workload                → Workload (agent cards)
// GET  /tickets/filter-options          → QueueFilterOptions (the Category filter)
// POST /tickets/bulk {ids, action}      → BulkTicketResult (one result per id)
// The list itself is GET /tickets with the same filters, `view` = QUEUE_TAB_VIEWS[tab] and
// `sort=priority` (open tabs) or `sort=recent` (Solved).

import { z } from 'zod';
import type { StaffView, TicketListSort } from '../tickets.ts';
import { categoryRefSchema, teamRefSchema, ticketFilterFieldsSchema } from './tickets.ts';

/** The design's agent card capacity: the bar is full at this many open tickets (F5). */
export const AGENT_QUEUE_CAPACITY = 6;

/** Team queue tabs (F3), in display order. */
export const QUEUE_TABS = ['open', 'unassigned', 'breaching', 'solved'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

/**
 * The GET /tickets `view` of each tab: All open = NEW, OPEN, PENDING; Unassigned = open with no
 * assignee; Breaching soon = the Inbox "SLA at risk" rule (at risk or already overdue, not
 * paused); Solved = SOLVED and CLOSED.
 */
export const QUEUE_TAB_VIEWS = {
  open: 'open',
  unassigned: 'unassigned',
  breaching: 'risk',
  solved: 'solved',
} as const satisfies Record<QueueTab, StaffView>;

/**
 * The GET /tickets `sort` of each tab: open tabs P1 → P4, then the next SLA due date; Solved most
 * recently updated first.
 */
export const QUEUE_TAB_SORTS = {
  open: 'priority',
  unassigned: 'priority',
  breaching: 'priority',
  solved: 'recent',
} as const satisfies Record<QueueTab, TicketListSort>;

/** GET /tickets/queue-counts — the list filters and search (without view, sort or paging). */
export const queueCountsQuerySchema = ticketFilterFieldsSchema;
export type QueueCountsQuery = z.infer<typeof queueCountsQuerySchema>;

/** Each tab's count equals the length of GET /tickets with the same filters and the tab's view. */
export const queueCountsSchema = z.object({
  tabs: z.object({
    open: z.number().int().nonnegative(),
    unassigned: z.number().int().nonnegative(),
    breaching: z.number().int().nonnegative(),
    solved: z.number().int().nonnegative(),
  }),
});
export type QueueCounts = z.infer<typeof queueCountsSchema>;

/**
 * One agent card (F5): an active staff member of the visible teams (super admins: every active
 * team), with their open (NEW / OPEN / PENDING) assigned tickets the caller can see, and how many
 * of those are "Breaching soon" (the tab's rule). Unfiltered by the queue's filters and search.
 */
export const workloadAgentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Their active teams among the visible ones, in team order (the card shows the first). */
  teams: z.array(teamRefSchema),
  open: z.number().int().nonnegative(),
  atRisk: z.number().int().nonnegative(),
});
export type WorkloadAgent = z.infer<typeof workloadAgentSchema>;

/**
 * GET /tickets/workload — agents sorted by open count (most first), then name. Also the options
 * of the queue's Assignee filter (plus "Unassigned").
 */
export const workloadSchema = z.object({
  /** AGENT_QUEUE_CAPACITY. */
  capacity: z.number().int().positive(),
  agents: z.array(workloadAgentSchema),
});
export type Workload = z.infer<typeof workloadSchema>;

/**
 * GET /tickets/filter-options — the queue's Category filter (F4): every active category in admin
 * order, then archived categories that still have tickets the caller can see (`isActive` false).
 */
export const queueFilterOptionsSchema = z.object({ categories: z.array(categoryRefSchema) });
export type QueueFilterOptions = z.infer<typeof queueFilterOptionsSchema>;

// ───────────── Bulk actions (F6) ─────────────

/** At most this many tickets per bulk request. */
export const BULK_TICKETS_MAX = 50;

/**
 * `assignToMe`: assign each ticket to the caller (a NEW ticket moves to OPEN, as in the panel);
 * `solve`: mark each ticket SOLVED. Each ticket goes through the single-ticket update (PATCH
 * /tickets/:id): same permissions, one TicketEvent per change, notifications and realtime.
 */
export const BULK_TICKET_ACTIONS = ['assignToMe', 'solve'] as const;
export type BulkTicketAction = (typeof BULK_TICKET_ACTIONS)[number];

export const bulkTicketsSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(BULK_TICKETS_MAX)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      error: 'validation.duplicateValue',
    }),
  action: z.enum(BULK_TICKET_ACTIONS),
});
export type BulkTicketsInput = z.infer<typeof bulkTicketsSchema>;

/**
 * Why one ticket of a bulk request was not changed:
 * - `not_found`: unknown, or not visible to the caller (existence is never revealed);
 * - `forbidden`: the caller may see it but not do this;
 * - `conflict`: the ticket's state does not allow it (e.g. CLOSED);
 * - `invalid`: a business rule refused it (e.g. the caller can't be assigned on that team);
 * - `internal`: something went wrong (try again).
 */
export const BULK_FAILURE_REASONS = [
  'not_found',
  'forbidden',
  'conflict',
  'invalid',
  'internal',
] as const;
export type BulkFailureReason = (typeof BULK_FAILURE_REASONS)[number];

export const bulkTicketOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.uuid(),
    ok: z.literal(true),
    /** false: the ticket already was that way (nothing written, no event). */
    changed: z.boolean(),
  }),
  z.object({
    id: z.uuid(),
    ok: z.literal(false),
    error: z.object({
      reason: z.enum(BULK_FAILURE_REASONS),
      /** English text for logs; the web shows its own text for `reason`. */
      message: z.string(),
    }),
  }),
]);
export type BulkTicketOutcome = z.infer<typeof bulkTicketOutcomeSchema>;

/**
 * One outcome per requested id, in request order. `updated` counts the ok ones, including those
 * that already were that way (`changed: false`); count `changed` for what the request did.
 */
export const bulkTicketResultSchema = z.object({
  results: z.array(bulkTicketOutcomeSchema),
  updated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type BulkTicketResult = z.infer<typeof bulkTicketResultSchema>;
