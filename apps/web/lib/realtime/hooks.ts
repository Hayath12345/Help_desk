'use client';

import type { TypingPayload } from '@loons/shared';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useViewer } from '@/lib/tickets/viewer';
import type { RealtimeStatus, ServerEventName, ServerEventPayload } from './client';
import { useRealtimeClient } from './provider';

/**
 * Joins the ticket's realtime room while mounted (and re-joins after reconnects). New messages
 * and ticket updates then flow into `useMessages` / `useTicket` / list caches automatically.
 */
export function useTicketRoom(ticketId: string | null | undefined): void {
  const client = useRealtimeClient();
  useEffect(() => {
    if (!client || !ticketId) return;
    return client.joinTicket(ticketId);
  }, [client, ticketId]);
}

/**
 * Joins several ticket rooms (e.g. the rows of a client's "My tickets" list, which gets no
 * team-queue events) so their `ticket:updated` pushes refresh the list in place.
 */
export function useTicketRooms(ticketIds: readonly string[]): void {
  const client = useRealtimeClient();
  const key = useMemo(() => [...new Set(ticketIds)].sort().join(','), [ticketIds]);
  useEffect(() => {
    if (!client || !key) return;
    const releases = key.split(',').map((id) => client.joinTicket(id));
    return () => releases.forEach((release) => release());
  }, [client, key]);
}

const idleStatus = (): RealtimeStatus => 'idle';
const noopSubscribe = () => () => undefined;

/** 'connected' | 'reconnecting' | … — e.g. for a "Reconnecting…" hint. */
export function useRealtimeStatus(): RealtimeStatus {
  const client = useRealtimeClient();
  return useSyncExternalStore(
    client ? (listener) => client.subscribeStatus(listener) : noopSubscribe,
    client ? () => client.getStatus() : idleStatus,
    idleStatus,
  );
}

/** Subscribes to a raw server event (the latest `handler` is always called). */
export function useRealtimeEvent<E extends ServerEventName>(
  event: E,
  handler: (payload: ServerEventPayload<E>) => void,
): void {
  const client = useRealtimeClient();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!client) return;
    return client.on(event, (payload) => ref.current(payload));
  }, [client, event]);
}

// ───────────── Typing ─────────────

export interface TypingUser {
  id: string;
  name: string;
  scope: TypingPayload['scope'];
}

/** Re-announce "still typing" this often while keys keep coming. */
export const TYPING_THROTTLE_MS = 2500;
/** Stop announcing after this long without input (contract: auto-stop after 4 s idle). */
export const TYPING_IDLE_MS = 4000;
/** Forget a remote typist we haven't heard from (a lost "stopped" event). */
export const TYPING_REMOTE_TTL_MS = 6000;

/**
 * "Is typing…" for one ticket:
 * - `typingUsers`: other people typing in this ticket (clients only ever receive client-side
 *   typing; staff also receive other staff, including internal-note typing).
 * - `notifyTyping()`: call on every input in the composer (throttled; stops after 4 s idle).
 * - `stopTyping()`: call after sending / clearing (also runs on unmount and ticket change).
 * `scope`: 'internal' while a staff member writes an internal note (the server routes all staff
 * typing to the staff room only).
 */
export function useTyping(
  ticketId: string | null | undefined,
  options: { scope?: TypingPayload['scope'] } = {},
): { typingUsers: TypingUser[]; notifyTyping: () => void; stopTyping: () => void } {
  const client = useRealtimeClient();
  const viewer = useViewer();
  const viewerId = viewer?.id;
  const scope = options.scope ?? 'public';

  // Remote typists, tagged with their ticket so switching tickets needs no reset.
  const [remote, setRemote] = useState<{ ticketId: string | null; users: TypingUser[] }>({
    ticketId: null,
    users: [],
  });

  useEffect(() => {
    if (!client || !ticketId) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const update = (fn: (users: TypingUser[]) => TypingUser[]) =>
      setRemote((prev) => ({ ticketId, users: fn(prev.ticketId === ticketId ? prev.users : []) }));
    const drop = (id: string) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      update((users) => users.filter((u) => u.id !== id));
    };
    const off = client.on('message:typing', (payload) => {
      if (!payload || payload.ticketId !== ticketId || !payload.user) return;
      const { id, name } = payload.user;
      if (typeof id !== 'string' || typeof name !== 'string' || id === viewerId) return;
      if (!payload.isTyping) {
        drop(id);
        return;
      }
      const user: TypingUser = {
        id,
        name,
        scope: payload.scope === 'internal' ? 'internal' : 'public',
      };
      update((users) => [...users.filter((u) => u.id !== id), user]);
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => drop(id), TYPING_REMOTE_TTL_MS),
      );
    });
    return () => {
      off();
      timers.forEach((timer) => clearTimeout(timer));
      setRemote({ ticketId: null, users: [] });
    };
  }, [client, ticketId, viewerId]);

  // Local typing: what we announced, for which ticket and scope.
  const local = useRef<{
    active: boolean;
    lastSentAt: number;
    ticketId: string | null;
    scope: TypingPayload['scope'];
    idle: ReturnType<typeof setTimeout> | null;
  }>({ active: false, lastSentAt: 0, ticketId: null, scope: 'public', idle: null });

  const stopTyping = useCallback(() => {
    const state = local.current;
    if (state.idle) clearTimeout(state.idle);
    state.idle = null;
    if (state.active && state.ticketId) {
      client?.sendTyping({ ticketId: state.ticketId, isTyping: false, scope: state.scope });
    }
    state.active = false;
  }, [client]);

  const notifyTyping = useCallback(() => {
    if (!client || !ticketId) return;
    const state = local.current;
    const now = Date.now();
    if (state.active && (state.ticketId !== ticketId || state.scope !== scope)) stopTyping();
    if (!state.active || now - state.lastSentAt >= TYPING_THROTTLE_MS) {
      client.sendTyping({ ticketId, isTyping: true, scope });
      state.active = true;
      state.lastSentAt = now;
      state.ticketId = ticketId;
      state.scope = scope;
    }
    if (state.idle) clearTimeout(state.idle);
    state.idle = setTimeout(stopTyping, TYPING_IDLE_MS);
  }, [client, ticketId, scope, stopTyping]);

  // Leaving the ticket (or unmounting) ends any announcement.
  useEffect(() => stopTyping, [ticketId, stopTyping]);

  const typingUsers = remote.ticketId === ticketId ? remote.users : EMPTY;
  return { typingUsers, notifyTyping, stopTyping };
}

const EMPTY: TypingUser[] = [];
