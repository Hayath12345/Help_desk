'use client';

// TanStack Query hooks of the Team queue. Keys: ./keys.ts (prefix 'queue'). Kept live by
// `queue:updated` and reconnects (lib/realtime/provider.tsx), `config:updated`
// (lib/realtime/config-scopes.ts) and the page's 60 s refresh.

import type { BulkTicketAction } from '@loons/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { isApiRequestError } from '@/lib/api/errors';
import { fetchTickets } from '@/lib/tickets/api';
import { selectTicketPages } from '@/lib/tickets/cache';
import { ticketKeys, type TicketListFilters } from '@/lib/tickets/keys';
import { fetchQueueCounts, fetchQueueFilterOptions, fetchWorkload, runBulkTickets } from './api';
import { invalidateQueueLive, queueKeys, type QueueFilters } from './keys';

const FIVE_MINUTES = 5 * 60_000;

/** Don't retry answers that won't change (403 / 404 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * The queue list: GET /tickets with the filters, the tab's view and sort (infinite, cursor-paged;
 * `data.items` = every loaded row). The previous rows stay (`isPlaceholderData`) while another
 * tab or filter loads.
 */
export function useQueueTickets(filters: TicketListFilters) {
  return useInfiniteQuery({
    queryKey: queueKeys.list(filters),
    queryFn: ({ pageParam, signal }) => fetchTickets(filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: selectTicketPages,
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
}

/** The tab counts for the filters + search (GET /tickets/queue-counts). */
export function useQueueCounts(filters: QueueFilters) {
  return useQuery({
    queryKey: queueKeys.count(filters),
    queryFn: ({ signal }) => fetchQueueCounts(filters, signal),
    placeholderData: keepPreviousData,
    retry: retryTransient,
  });
}

/** Agent cards and the Assignee filter's people (GET /tickets/workload). */
export function useWorkload() {
  return useQuery({
    queryKey: queueKeys.workload(),
    queryFn: ({ signal }) => fetchWorkload(signal),
    retry: retryTransient,
  });
}

/** The Category filter's options (GET /tickets/filter-options); config changes refresh it. */
export function useQueueFilterOptions() {
  return useQuery({
    queryKey: queueKeys.filterOptions(),
    queryFn: ({ signal }) => fetchQueueFilterOptions(signal),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
  });
}

/**
 * After a bulk action: the queue (list, tab counts, agent cards), the Inbox lists and counts, and
 * any cached detail of a ticket it touched. Realtime brings the same changes to other tabs.
 */
export function invalidateAfterBulk(queryClient: QueryClient, ids: readonly string[]): void {
  const touched = new Set(ids);
  invalidateQueueLive(queryClient);
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
  void queryClient.invalidateQueries({
    queryKey: ticketKeys.details(),
    predicate: (query) => touched.has((query.state.data as { id?: string } | undefined)?.id ?? ''),
  });
}

export interface BulkTicketsVariables {
  ids: readonly string[];
  action: BulkTicketAction;
}

/**
 * POST /tickets/bulk (F6), server-confirmed (not optimistic): answers per ticket; the caller
 * shows the toast. Refetches everything the change touches when it settles.
 */
export function useBulkTickets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ['queue', 'bulk'],
    mutationFn: ({ ids, action }: BulkTicketsVariables) => runBulkTickets(ids, action),
    onSettled: (_result, _error, { ids }) => invalidateAfterBulk(queryClient, ids),
  });
}
