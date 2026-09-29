// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/realtime — Socket.IO client for tickets (spec §8, docs/PHASE2_CONTRACT.md → Web → Realtime)
//
// Mount once per signed-in area (the portal / console layouts), inside AppProviders:
//   <RealtimeProvider>{children}</RealtimeProvider>   (or <TicketingProviders> from
//   components/tickets, which also mounts ViewerProvider + NewTicketProvider)
//
// Exports
//   RealtimeProvider        Opens the tab's single connection (API origin, path /socket.io, token
//                           auth, reconnect with a fresh token) and pipes events into the caches:
//                           message:new → thread, ticket:updated → detail + lists, queue:updated →
//                           lists/counts (debounced), config:updated → form config, notification:new
//                           → the console bell's list (lib/notifications), room joined (first
//                           join and every re-join) → thread catch-up (`?after=` last id), reconnect
//                           (after the re-joins) → refetch tickets, lists and notifications.
//   useTicketRoom(id)       Join/leave `ticket:{id}` while mounted (ref-counted, serialised per ticket:
//                           the next join/leave waits for the previous ack; re-joined on reconnect).
//   useTicketRooms(ids)     Same for many tickets (e.g. a client's list rows). A socket may hold at
//                           most MAX_TICKET_ROOMS_PER_SOCKET rooms: keep lists well below it (the
//                           portal list joins MAX_TICKET_ROOMS_PER_SOCKET - 10). When the ids change,
//                           the dropped rooms are left before the new ones are joined; a join refused
//                           as TOO_MANY_ROOMS / RATE_LIMITED is retried (after a leave / backoff).
//   useTyping(id, {scope})  { typingUsers, notifyTyping, stopTyping } — throttled emit, 4 s idle stop.
//   useRealtimeStatus()     'idle' | 'connecting' | 'connected' | 'reconnecting' | 'forbidden' | 'stopped'.
//   useRealtimeEvent(e, fn) Raw server event subscription (e.g. flash a row on queue:updated).
//   useRealtimeClient()     The RealtimeClient (advanced; null outside the provider).
//   RealtimeClient, getRealtimeClient, connectRealtimeToCache, catchUpThread
//                           Framework-free pieces (tests, custom wiring).
//   TYPING_THROTTLE_MS, TYPING_IDLE_MS, TYPING_REMOTE_TTL_MS
// ─────────────────────────────────────────────────────────────────────────────────────────────

export {
  RealtimeClient,
  SOCKET_PATH,
  getRealtimeClient,
  type ClientSocket,
  type RealtimeClientOptions,
  type RealtimeStatus,
  type ServerEventName,
  type ServerEventPayload,
  type SocketFactory,
} from './client';
export {
  RealtimeProvider,
  catchUpThread,
  connectRealtimeToCache,
  useRealtimeClient,
} from './provider';
export {
  TYPING_IDLE_MS,
  TYPING_REMOTE_TTL_MS,
  TYPING_THROTTLE_MS,
  useRealtimeEvent,
  useRealtimeStatus,
  useTicketRoom,
  useTicketRooms,
  useTyping,
  type TypingUser,
} from './hooks';
