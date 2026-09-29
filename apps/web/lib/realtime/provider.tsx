'use client';

// Wires the tab's realtime connection into the TanStack Query caches (docs/PHASE2_CONTRACT.md →
// Web → Realtime):
// - message:new     → insert into that ticket's thread (deduplicated by id and clientTempId); a
//                     thread whose first load is in flight gets it when the load finishes
// - ticket:updated  → update the ticket detail and every cached list row
// - queue:updated   → refetch lists and counts (debounced: one burst → one refetch)
// - config:updated  → refetch the New-ticket configuration
// - room joined     → (first join and every re-join) fetch what the thread may have missed before
//                     the join: `after` its last known message
// - after a reconnect (once the rooms are joined again): refetch tickets, lists and counts.

import { messageDtoSchema, ticketSummaryDtoSchema } from '@loons/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { fetchAllMessages } from '@/lib/tickets/api';
import {
  applyTicketSummary,
  lastServerMessageId,
  mergeServerMessages,
  requestThreadCatchUp,
  updateThread,
  upsertThreadMessage,
} from '@/lib/tickets/cache';
import { ticketKeys } from '@/lib/tickets/keys';
import type { ThreadMessage } from '@/lib/tickets/types';
import { getRealtimeClient, type RealtimeClient } from './client';

const RealtimeContext = createContext<RealtimeClient | null>(null);

/** The tab's realtime client inside a `RealtimeProvider` (null outside one, or when disabled). */
export function useRealtimeClient(): RealtimeClient | null {
  return useContext(RealtimeContext);
}

const LIST_REFRESH_DEBOUNCE_MS = 400;

function debounce(fn: () => void, ms: number): { run: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    run: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Brings a thread up to date after its ticket room was (re)joined: messages stored before the
 * join (while disconnected, or while the room wasn't held) were never pushed to this tab.
 * - Not cached: nothing to do (its first load will read everything).
 * - First load in flight: that load fetches what came after its snapshot (see `loadThread`).
 * - On screen: fetch the messages after the last known one and merge them.
 * - Cached but not on screen: mark it stale, so it reloads when it is shown again.
 */
export async function catchUpThread(queryClient: QueryClient, ticketId: string): Promise<void> {
  const key = ticketKeys.messages(ticketId);
  const query = queryClient.getQueryCache().find<ThreadMessage[]>({ queryKey: key, exact: true });
  if (!query) return;
  const cached = query.state.data;
  if (cached === undefined) {
    if (query.state.fetchStatus === 'fetching') requestThreadCatchUp(queryClient, ticketId);
    return;
  }
  const after = lastServerMessageId(cached);
  if (!after || query.getObserversCount() === 0) {
    await queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  const missed = await fetchAllMessages(ticketId, { after });
  if (missed.length)
    updateThread(queryClient, ticketId, (list) => mergeServerMessages(list, missed));
}

/** Subscribes the query caches to a realtime client. Returns the cleanup. */
export function connectRealtimeToCache(
  client: RealtimeClient,
  queryClient: QueryClient,
): () => void {
  const refreshLists = debounce(() => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
  }, LIST_REFRESH_DEBOUNCE_MS);
  const refreshCounts = debounce(() => {
    void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
  }, LIST_REFRESH_DEBOUNCE_MS);

  const offs = [
    client.on('message:new', (payload) => {
      const parsed = messageDtoSchema.safeParse(payload?.message);
      if (!parsed.success || parsed.data.ticketId !== payload.ticketId) return;
      // Only threads someone has loaded or is loading are kept up to date (the others read
      // everything when they load); a thread still loading gets it when its load finishes.
      updateThread(
        queryClient,
        payload.ticketId,
        (list) => upsertThreadMessage(list, parsed.data),
        'if-tracked',
      );
    }),
    client.on('ticket:updated', (payload) => {
      const parsed = ticketSummaryDtoSchema.safeParse(payload?.ticket);
      if (!parsed.success) return;
      const detailWasOlder = applyTicketSummary(queryClient, parsed.data);
      // Detail-only fields (SLA policy, custom fields, asset…) may have changed too.
      if (detailWasOlder) {
        void queryClient.invalidateQueries({
          queryKey: ticketKeys.details(),
          predicate: (query) =>
            (query.state.data as { id?: string } | undefined)?.id === parsed.data.id,
        });
      }
      refreshCounts.run();
    }),
    client.on('queue:updated', () => refreshLists.run()),
    client.on('config:updated', () => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.formConfig() });
    }),
    client.onRoomJoined((ticketId) => {
      void catchUpThread(queryClient, ticketId).catch(() =>
        queryClient.invalidateQueries({ queryKey: ticketKeys.messages(ticketId) }),
      );
    }),
    client.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ticketKeys.details() });
      refreshLists.run();
    }),
  ];

  return () => {
    offs.forEach((off) => off());
    refreshLists.cancel();
    refreshCounts.cancel();
  };
}

/**
 * Opens the tab's Socket.IO connection and keeps the ticket caches live. Mount it once per
 * signed-in area (portal / console layouts), inside the QueryClientProvider. `enabled` must only
 * be true for ACTIVE, verified users (the layouts' `requireUser()` guarantees that).
 */
export function RealtimeProvider({
  enabled = true,
  children,
}: {
  enabled?: boolean;
  children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  // Browser-only singleton (null during SSR): components below may join rooms before the
  // connection opens; rooms are (re)joined on every connect.
  const client = useMemo(() => (enabled ? getRealtimeClient() : null), [enabled]);

  useEffect(() => {
    if (!client) return;
    const disconnect = connectRealtimeToCache(client, queryClient);
    client.acquire();
    return () => {
      disconnect();
      client.release();
    };
  }, [client, queryClient]);

  return <RealtimeContext.Provider value={client}>{children}</RealtimeContext.Provider>;
}
