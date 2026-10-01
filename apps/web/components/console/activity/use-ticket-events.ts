'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isApiRequestError } from '@/lib/api/errors';
import { useRealtimeClient } from '@/lib/realtime/provider';
import { activityKeys, fetchTicketEvents } from './api';

/** One refetch per burst of `ticket:updated` (a bulk change, a step firing with its alerts). */
export const ACTIVITY_REFRESH_DEBOUNCE_MS = 500;

/** Don't retry answers that won't change (403 / 404 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * A ticket's events, newest first (infinite, cursor-paged). Mounted only while the Activity
 * section is open: every mount refetches (the section opening), and while it is mounted a
 * `ticket:updated` for this ticket (debounced) and a reconnect refetch the loaded pages. The
 * events themselves are never pushed: the API writes them next to the ticket change it announces.
 */
export function useTicketEvents(ticketId: string) {
  const queryClient = useQueryClient();
  const realtime = useRealtimeClient();

  const query = useInfiniteQuery({
    queryKey: activityKeys.events(ticketId),
    queryFn: ({ pageParam, signal }) => fetchTicketEvents(ticketId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchOnMount: 'always',
    retry: retryTransient,
  });

  useEffect(() => {
    if (!realtime) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: activityKeys.events(ticketId) });
      }, ACTIVITY_REFRESH_DEBOUNCE_MS);
    };
    const offs = [
      realtime.on('ticket:updated', (payload) => {
        if ((payload as { ticket?: { id?: unknown } } | null)?.ticket?.id === ticketId) refresh();
      }),
      realtime.onReconnect(refresh),
    ];
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [realtime, queryClient, ticketId]);

  return query;
}
