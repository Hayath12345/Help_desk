'use client';

// TanStack Query hooks (reads). Keys: ./keys.ts. Mutations: ./mutations.ts. Realtime keeps these
// caches fresh (lib/realtime), so most queries don't poll.

import type { MessageDto } from '@loons/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { isApiRequestError } from '@/lib/api/errors';
import {
  fetchAllMessages,
  fetchFormContext,
  fetchMacros,
  fetchRequesters,
  fetchTeams,
  fetchTicket,
  fetchTicketCounts,
  fetchTickets,
} from './api';
import {
  lastServerMessageId,
  mergeServerMessages,
  mergeThreadMessages,
  selectTicketPages,
  takeParkedThreadWrites,
  takeThreadCatchUp,
} from './cache';
import { loadTicketFormConfig } from './config-version';
import { ticketKeys, type TicketListFilters } from './keys';
import type { ThreadMessage } from './types';

const FIVE_MINUTES = 5 * 60_000;

/** Don't retry answers that won't change (403 / 404 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * Live New-ticket configuration (categories → sub-types → fields, SLA policies, SOC phone). Kept
 * current by `config:updated` (refetched until it reaches the announced version).
 */
export function useTicketFormConfig(options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ticketKeys.formConfig(),
    queryFn: ({ signal }) => loadTicketFormConfig(queryClient, signal),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/**
 * Who a new ticket is for: requester, organisation (+ contract) and its sites. Clients call it
 * without `requesterId` (always themselves); staff pass the chosen client and keep the query
 * idle (`enabled: false`) until one is chosen — the API requires it for staff.
 */
export function useFormContext(requesterId?: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ticketKeys.formContext(requesterId || null),
    queryFn: ({ signal }) => fetchFormContext(requesterId || null, signal),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/** Staff requester picker (active, verified clients). Pass an already debounced search. */
export function useRequesterSearch(search: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ticketKeys.requesters(search),
    queryFn: ({ signal }) => fetchRequesters(search, { signal }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/**
 * A ticket list (infinite, cursor-paginated). `data.items` holds every loaded ticket in order;
 * call `fetchNextPage()` while `hasNextPage`. Realtime updates rows in place and refetches the
 * list when the queue changes.
 */
export function useTickets(
  filters: TicketListFilters,
  options: { enabled?: boolean; keepPrevious?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ pageParam, signal }) => fetchTickets(filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: selectTicketPages,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/** Sidebar / tab counts (`kind: 'staff'` views + teams, or `kind: 'client'` tabs). */
export function useTicketCounts(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ticketKeys.counts(),
    queryFn: ({ signal }) => fetchTicketCounts(signal),
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/** Ticket detail by uuid or "LG-4817". A 404 (unknown or not visible) is not retried. */
export function useTicket(ref: string | null | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ticketKeys.detail(ref ?? ''),
    queryFn: ({ signal }) => fetchTicket(ref ?? '', signal),
    retry: retryTransient,
    enabled: (options.enabled ?? true) && !!ref,
  });
}

/** Follow-up fetches one load makes at most for realtime joins that happened during it. */
const MAX_CATCH_UPS = 3;

/**
 * Fetches the whole thread and merges it with what the cache holds when the fetch finishes —
 * optimistic (pending / failed) messages, realtime pushes and sends that arrived meanwhile, and
 * writes parked while the thread had not loaded yet — so nothing is dropped whatever the order.
 * When the ticket's realtime room was joined during the load, it also fetches what was stored
 * after its snapshot (those messages were never pushed to this tab).
 */
export async function loadThread(
  queryClient: QueryClient,
  ticketId: string,
  signal?: AbortSignal,
): Promise<ThreadMessage[]> {
  let fetched: ThreadMessage[] = await fetchAllMessages(ticketId, { signal });
  for (let i = 0; i < MAX_CATCH_UPS && takeThreadCatchUp(queryClient, ticketId); i += 1) {
    const after = lastServerMessageId(fetched);
    const missed: MessageDto[] = await fetchAllMessages(ticketId, { after, signal });
    fetched = mergeServerMessages(fetched, missed);
  }
  const cached = queryClient.getQueryData<ThreadMessage[]>(ticketKeys.messages(ticketId));
  const parked = takeParkedThreadWrites(queryClient, ticketId);
  return mergeThreadMessages(mergeThreadMessages(cached, parked), fetched);
}

/**
 * The conversation of a ticket (ascending; clients never receive internal notes). Includes the
 * optimistic messages of `useSendMessage` (`message.local`). Realtime `message:new` events are
 * merged in by `useTicketRoom` + the realtime provider.
 */
export function useMessages(
  ticketId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ticketKeys.messages(ticketId ?? ''),
    queryFn: ({ signal }) => loadThread(queryClient, ticketId ?? '', signal),
    retry: retryTransient,
    enabled: (options.enabled ?? true) && !!ticketId,
  });
}

/** Staff: global macros + macros of the caller's teams. */
export function useMacros(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ticketKeys.macros(),
    queryFn: ({ signal }) => fetchMacros(signal),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}

/**
 * Staff: active teams with their active members (assignee picker, Teams column).
 * `includeArchived` also lists archived teams (a ticket on an archived team, E6); it is cached
 * under the same prefix, so a `teams` config change refreshes both.
 */
export function useTeams(options: { enabled?: boolean; includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? false;
  return useQuery({
    queryKey: includeArchived ? [...ticketKeys.teams(), 'with-archived'] : ticketKeys.teams(),
    queryFn: ({ signal }) => fetchTeams(signal, { includeArchived }),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
    enabled: options.enabled ?? true,
  });
}
