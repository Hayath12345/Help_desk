// TanStack Query keys of the Team queue (Phase 5 F16). Everything starts with 'queue' — never
// under ['tickets', 'list'], whose cache shape (TicketPages patched in place by realtime and the
// optimistic ticket mutations) the Inbox relies on.

import type { TicketFilterFields } from '@loons/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { normalizeListFilters, type TicketListFilters } from '@/lib/tickets/keys';

/** The queue's filters and search (GET /tickets/queue-counts; the list adds view and sort). */
export type QueueFilters = Pick<
  TicketFilterFields,
  'priority' | 'categoryId' | 'assigneeId' | 'search'
>;

export const queueKeys = {
  all: ['queue'] as const,
  /** Every queue list (prefix of `list`). */
  lists: () => ['queue', 'list'] as const,
  /** GET /tickets with the queue's filters, view and sort (infinite, cursor-paged). */
  list: (filters: TicketListFilters) => ['queue', 'list', normalizeListFilters(filters)] as const,
  /** Every tab-count query (prefix of `count`). */
  counts: () => ['queue', 'counts'] as const,
  /** GET /tickets/queue-counts for the filters + search. */
  count: (filters: QueueFilters) => ['queue', 'counts', normalizeListFilters(filters)] as const,
  /** GET /tickets/workload (agent cards + the Assignee filter's people). */
  workload: () => ['queue', 'workload'] as const,
  /** GET /tickets/filter-options (the Category filter). */
  filterOptions: () => ['queue', 'filter-options'] as const,
};

/**
 * What moves with the tickets themselves — the list, the tab counts and the agent cards — and is
 * refetched on `queue:updated`, after a bulk action and every 60 s. The filter options only follow
 * `config:updated` (scope `ticket-form`) and reconnects.
 */
export const QUEUE_LIVE_KEYS: readonly QueryKey[] = [
  queueKeys.lists(),
  queueKeys.counts(),
  queueKeys.workload(),
];

/** Refetches the live queue data (active queries) or marks it stale (inactive ones). */
export function invalidateQueueLive(queryClient: QueryClient): void {
  for (const queryKey of QUEUE_LIVE_KEYS) void queryClient.invalidateQueries({ queryKey });
}
