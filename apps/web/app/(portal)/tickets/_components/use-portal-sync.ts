'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { fetchTicket } from '@/lib/tickets/api';
import { ticketKeys } from '@/lib/tickets/keys';
import { loadThread } from '@/lib/tickets/queries';

/** How often "My tickets" re-checks the lists while the tab is visible. */
export const PORTAL_REFRESH_MS = 60_000;

function refreshLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
}

/**
 * Clients receive no team-queue events (`queue:updated` goes to staff rooms only), and the rows'
 * ticket rooms only cover tickets already on screen. A ticket raised on the client's behalf by
 * Loons staff would otherwise only show up after a reload, so the lists and tab counts refresh
 * when the browser tab becomes visible again and once a minute while it is visible.
 */
export function usePortalListSync(intervalMs: number = PORTAL_REFRESH_MS): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const visible = () => document.visibilityState === 'visible';
    const onVisibility = () => {
      if (visible()) refreshLists(queryClient);
    };
    const timer = setInterval(() => {
      if (visible()) refreshLists(queryClient);
    }, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [queryClient, intervalMs]);
}

/** How long a hover / focus prefetch of a ticket counts as fresh. */
const PREFETCH_STALE_MS = 30_000;

/**
 * Warms a ticket's detail and conversation (row hover / focus), so its thread page opens with
 * content instead of skeletons.
 */
export function usePrefetchTicket(): (ticket: { id: string; ref: string }) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (ticket) => {
      void queryClient.prefetchQuery({
        queryKey: ticketKeys.detail(ticket.ref),
        queryFn: ({ signal }) => fetchTicket(ticket.ref, signal),
        staleTime: PREFETCH_STALE_MS,
      });
      void queryClient.prefetchQuery({
        queryKey: ticketKeys.messages(ticket.id),
        queryFn: ({ signal }) => loadThread(queryClient, ticket.id, signal),
        staleTime: PREFETCH_STALE_MS,
      });
    },
    [queryClient],
  );
}
