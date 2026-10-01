// One Socket.IO connection per browser tab (spec §8), framework-free so it is unit-tested with a
// fake socket. React wiring lives in ./provider.tsx and ./hooks.ts.
//
// Connection rules (docs/PHASE2_CONTRACT.md → Realtime, PHASE1_HANDOFF carry-overs):
// - `auth: cb => cb({ token })` with the short-lived API token from /api/token; the server checks
//   it once at the handshake.
// - The server CLOSES the socket when that token expires or the user's sessions are revoked
//   (reason 'io server disconnect'), and REFUSES a handshake with an 'UNAUTHENTICATED' /
//   'FORBIDDEN' error. Socket.IO does not reconnect by itself after either, so this client does:
//   with a force-refreshed token and exponential backoff. FORBIDDEN (not an ACTIVE, verified
//   user) and a signed-out web session (/api/token → 401) stop it for good.
// - Rooms are per connection: every held ticket room is re-joined after each (re)connect. Room
//   requests are serialised per ticket (the next join / leave waits for the previous ack), so a
//   quick join -> leave or leave -> join always ends in the state the components asked for, and a
//   release immediately followed by a re-acquire (a re-render) sends nothing.
// - The server caps the ticket rooms of one socket (MAX_TICKET_ROOMS_PER_SOCKET). Rooms released
//   and acquired in the same tick (an effect swap: a list whose rows changed) are synced together a
//   microtask later, the leaves BEFORE the joins, so a swap at the cap never asks for one room too
//   many. A join refused as `TOO_MANY_ROOMS` is tried again when one of this tab's leaves completes
//   (or after a backoff); `RATE_LIMITED` after a backoff (1 s doubling to 30 s). Other refusals
//   (`NOT_FOUND`, `FORBIDDEN`, …) are final until the room is re-acquired or the tab reconnects.
// - Every successful join is announced (`onRoomJoined`) so caches can fetch what they may have
//   missed before it; reconnect listeners run once the re-joins have been answered.

import {
  SERVER_EVENTS,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketAck,
  type TypingRequest,
} from '@loons/shared';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { getApiToken } from '@/lib/api/browser';
import { isApiRequestError } from '@/lib/api/errors';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type ServerEventName = keyof ServerToClientEvents;
export type ServerEventPayload<E extends ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

export type RealtimeStatus =
  /** Not started. */
  | 'idle'
  | 'connecting'
  | 'connected'
  /** Lost the connection (or the server closed it); trying again. */
  | 'reconnecting'
  /** The account may not use realtime (pending approval / unverified); never retried. */
  | 'forbidden'
  /** Stopped (provider unmounted, or the web session ended). */
  | 'stopped';

export type SocketFactory = (
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
) => ClientSocket;

export interface RealtimeClientOptions {
  /** API origin (NEXT_PUBLIC_API_URL); Socket.IO lives on its /socket.io path. */
  url: string;
  getToken: (options: { forceRefresh: boolean }) => Promise<string>;
  /** Injected in tests. */
  createSocket?: SocketFactory;
  /** Delay before manual reconnect attempt `n` (0-based). */
  backoffMs?: (attempt: number) => number;
  ackTimeoutMs?: number;
  /** How long `release()` waits before closing, so a quick re-acquire keeps the connection. */
  idleCloseMs?: number;
  /** Delay before retrying a room join refused as `RATE_LIMITED` / `TOO_MANY_ROOMS` (0-based). */
  roomRetryMs?: (attempt: number) => number;
}

export const SOCKET_PATH = '/socket.io';

const defaultBackoff = (attempt: number) =>
  Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** 1 s, 2 s, 4 s … up to 30 s, with jitter so a list's refused joins don't come back together. */
const defaultRoomRetry = (attempt: number) =>
  Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** Join refusals that go away by themselves (shared SocketAck contract). */
const RETRYABLE_JOIN_ERRORS: ReadonlySet<string> = new Set(['RATE_LIMITED', 'TOO_MANY_ROOMS']);

const defaultFactory: SocketFactory = (url, options) => io(url, options);

type Listener<E extends ServerEventName> = (payload: ServerEventPayload<E>) => void;

/** One ticket room of this tab. */
interface RoomState {
  /** Components holding the room (ref count). */
  holders: number;
  /** The server confirmed the join on the current connection (or may have: a timed-out join). */
  joined: boolean;
  /** A request waiting for its ack; the next one is sent after it. */
  pending: 'join' | 'leave' | null;
  /** The last join was refused: not retried until the room is re-acquired or the tab reconnects. */
  refused: boolean;
  /**
   * The last join was refused for a passing reason (RATE_LIMITED / TOO_MANY_ROOMS): tried again
   * when `timer` fires or, for `afterLeave`, as soon as one of this tab's leaves completes.
   */
  retry: { timer: ReturnType<typeof setTimeout>; afterLeave: boolean } | null;
  /** Retryable refusals in a row (the backoff step). */
  retries: number;
}

export class RealtimeClient {
  private socket: ClientSocket | null = null;
  private status: RealtimeStatus = 'idle';
  private readonly statusListeners = new Set<() => void>();
  private readonly eventListeners = new Map<ServerEventName, Set<(payload: unknown) => void>>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly roomJoinedListeners = new Set<(ticketId: string) => void>();
  private readonly rooms = new Map<string, RoomState>();
  /** Rooms released (or acquired behind a release) this tick: synced in a microtask, leaves first. */
  private readonly queuedRooms = new Set<string>();
  private roomFlushQueued = false;
  /** Bumped on every connect / disconnect: acks of an earlier connection are ignored. */
  private epoch = 0;
  private forceRefresh = false;
  private everConnected = false;
  private signedOut = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private holders = 0;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RealtimeClientOptions) {}

  // ───────────── Lifecycle ─────────────

  /** Reference-counted start: the first holder connects. */
  acquire(): void {
    this.holders += 1;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.start();
  }

  /** The last holder closes the connection (after `idleCloseMs`, so remounts don't churn). */
  release(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders > 0 || this.closeTimer) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.holders === 0) this.stop();
    }, this.options.idleCloseMs ?? 1000);
  }

  start(): void {
    if (this.socket || this.status === 'forbidden') return;
    this.signedOut = false;
    this.everConnected = false;
    this.attempts = 0;
    const socket = (this.options.createSocket ?? defaultFactory)(this.options.url, {
      path: SOCKET_PATH,
      autoConnect: false,
      // The browser sends the load balancer's stickiness cookie (AWSALB) with the long-polling
      // requests to the API origin. Socket.IO's first requests are polling, and with more than one
      // API instance they must reach the same instance (docs/DEPLOYMENT.md, "Scaling"); a
      // cross-origin request carries cookies only with this flag. The API's CORS answers
      // `credentials: true` for the allowed origins.
      withCredentials: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      auth: (cb) => this.provideAuth(cb),
    });
    this.socket = socket;
    socket.on('connect', this.onConnect);
    socket.on('disconnect', this.onDisconnect);
    socket.on('connect_error', this.onConnectError);
    for (const event of Object.values(SERVER_EVENTS)) {
      // Each event keeps its own payload type for listeners; the socket side is untyped here.
      (socket.on as (ev: string, fn: (payload: unknown) => void) => void)(event, (payload) =>
        this.dispatch(event, payload),
      );
    }
    this.setStatus('connecting');
    socket.connect();
  }

  stop(): void {
    this.clearRetry();
    for (const room of this.rooms.values()) this.clearRoomRetry(room);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.off();
      socket.disconnect();
    }
    if (this.status !== 'forbidden') this.setStatus('stopped');
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ───────────── Events ─────────────

  /** Listens to a server event; returns the unsubscribe function. */
  on<E extends ServerEventName>(event: E, listener: Listener<E>): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    const fn = listener as (payload: unknown) => void;
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Called after every RE-connect (not the first connect), once the ticket rooms have been
   * re-joined: refetch what may have been missed.
   */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /**
   * Called each time the server confirms a ticket room join (first join and re-joins). Pushes
   * only flow from then on, so anything stored before may have to be fetched.
   */
  onRoomJoined(listener: (ticketId: string) => void): () => void {
    this.roomJoinedListeners.add(listener);
    return () => this.roomJoinedListeners.delete(listener);
  }

  // ───────────── Rooms & typing ─────────────

  /** Joins `ticket:{id}` (+ the staff room server-side when allowed). Returns the release. */
  joinTicket(ticketId: string): () => void {
    let room = this.rooms.get(ticketId);
    if (!room) {
      room = { holders: 0, joined: false, pending: null, refused: false, retry: null, retries: 0 };
      this.rooms.set(ticketId, room);
    }
    room.holders += 1;
    if (room.holders === 1) room.refused = false; // a new holder may try a refused room again
    // Behind a release of this tick (an effect swap), the join waits for that release's leave.
    if (this.roomFlushQueued) this.queuedRooms.add(ticketId);
    else void this.syncRoom(ticketId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.rooms.get(ticketId);
      if (!current) return;
      current.holders = Math.max(0, current.holders - 1);
      // Leave a moment later: a re-acquire in the same tick (re-render, StrictMode, a list whose
      // rows changed) keeps the room without a leave / join round trip.
      if (current.holders === 0) this.queueRoomSync(ticketId);
    };
  }

  /** Ticket rooms currently held by at least one component. */
  joinedTickets(): string[] {
    return [...this.rooms].filter(([, room]) => room.holders > 0).map(([id]) => id);
  }

  /** Typing notifications are fire-and-forget (dropped while disconnected). */
  sendTyping(payload: TypingRequest): void {
    if (!this.socket?.connected) return;
    this.socket.volatile.emit('message:typing', payload, () => undefined);
  }

  // ───────────── Internals ─────────────

  private queueRoomSync(ticketId: string): void {
    this.queuedRooms.add(ticketId);
    if (this.roomFlushQueued) return;
    this.roomFlushQueued = true;
    queueMicrotask(this.flushQueuedRooms);
  }

  /** Syncs this tick's released / acquired rooms: every leave is sent before any join. */
  private readonly flushQueuedRooms = (): void => {
    this.roomFlushQueued = false;
    const ids = [...this.queuedRooms];
    this.queuedRooms.clear();
    const wanted = (id: string) => (this.rooms.get(id)?.holders ?? 0) > 0;
    for (const id of ids) if (!wanted(id)) void this.syncRoom(id);
    for (const id of ids) if (wanted(id)) void this.syncRoom(id);
  };

  private clearRoomRetry(room: RoomState): void {
    if (room.retry) clearTimeout(room.retry.timer);
    room.retry = null;
  }

  /** A passing refusal: try the join again later (see RoomState.retry). */
  private scheduleRoomRetry(ticketId: string, room: RoomState, afterLeave: boolean): void {
    this.clearRoomRetry(room);
    const delay = (this.options.roomRetryMs ?? defaultRoomRetry)(room.retries);
    room.retries += 1;
    const timer = setTimeout(() => this.retryRoom(ticketId, room), delay);
    room.retry = { timer, afterLeave };
  }

  private retryRoom(ticketId: string, room: RoomState): void {
    this.clearRoomRetry(room);
    if (this.rooms.get(ticketId) === room) void this.syncRoom(ticketId);
  }

  /** A leave completed: a room refused for the rooms cap may be joined now (one per leave). */
  private retryRoomWaitingForLeave(): void {
    for (const [ticketId, room] of this.rooms) {
      if (room.retry?.afterLeave && room.holders > 0) {
        this.retryRoom(ticketId, room);
        return;
      }
    }
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((listener) => listener());
  }

  private dispatch(event: ServerEventName, payload: unknown): void {
    this.eventListeners.get(event)?.forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[realtime] ${event} listener failed`, error);
      }
    });
  }

  private provideAuth(cb: (data: object) => void): void {
    const forceRefresh = this.forceRefresh;
    this.forceRefresh = false;
    this.options.getToken({ forceRefresh }).then(
      (token) => cb({ token }),
      (error: unknown) => {
        // Signed out (or the session ended): the handshake fails and nothing retries.
        if (isApiRequestError(error) && error.status === 401) this.signedOut = true;
        cb({ token: '' });
      },
    );
  }

  /**
   * Moves a room towards what its holders want: one request at a time per ticket, the next one
   * once the previous ack arrived. Resolves when this step's ack arrived (at once when nothing
   * had to be sent).
   */
  private syncRoom(ticketId: string): Promise<void> {
    const room = this.rooms.get(ticketId);
    const socket = this.socket;
    if (!room) return Promise.resolve();
    const wanted = room.holders > 0;
    if (!wanted) {
      this.clearRoomRetry(room);
      room.retries = 0;
    }
    if (room.pending || !socket?.connected) return Promise.resolve();
    if (wanted && !room.joined && !room.refused && !room.retry) {
      return this.emitRoom(socket, room, 'join', ticketId);
    }
    if (!wanted && room.joined) return this.emitRoom(socket, room, 'leave', ticketId);
    if (!wanted) this.rooms.delete(ticketId);
    return Promise.resolve();
  }

  private emitRoom(
    socket: ClientSocket,
    room: RoomState,
    op: 'join' | 'leave',
    ticketId: string,
  ): Promise<void> {
    const epoch = this.epoch;
    room.pending = op;
    const event = op === 'join' ? 'ticket:join' : 'ticket:leave';
    return new Promise((resolve) => {
      socket
        .timeout(this.options.ackTimeoutMs ?? 10_000)
        .emit(event, { ticketId }, (err: Error | null, res?: SocketAck) => {
          // An ack from an earlier connection: its rooms were reset (and re-joined) on connect.
          if (epoch !== this.epoch || this.rooms.get(ticketId) !== room) {
            resolve();
            return;
          }
          room.pending = null;
          const ok = !err && !!res?.ok;
          const refusal = !err && res && !res.ok ? res.error : null;
          if (op === 'join' && refusal && RETRYABLE_JOIN_ERRORS.has(refusal)) {
            // Not in the room, and not refused for good: try again later (only while held).
            room.joined = false;
            room.refused = false;
            if (room.holders > 0) {
              this.scheduleRoomRetry(ticketId, room, refusal === 'TOO_MANY_ROOMS');
            }
          } else if (op === 'join') {
            // A timed-out join may still have happened: remember it so a release leaves.
            room.joined = ok || !!err;
            room.refused = !ok;
            if (ok) room.retries = 0;
          } else {
            room.joined = false;
          }
          if (!ok && process.env.NODE_ENV !== 'production') {
            console.warn(`[realtime] ${event} ${ticketId} failed`, err ?? res);
          }
          if (op === 'join' && ok) this.notify(this.roomJoinedListeners, ticketId);
          void this.syncRoom(ticketId);
          if (op === 'leave' && ok) this.retryRoomWaitingForLeave();
          resolve();
        });
    });
  }

  private notify<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
    listeners.forEach((listener) => {
      try {
        listener(...args);
      } catch (error) {
        console.error('[realtime] listener failed', error);
      }
    });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || !this.socket) return;
    const delay = (this.options.backoffMs ?? defaultBackoff)(this.attempts);
    this.attempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const socket = this.socket;
      if (socket && !socket.connected && !socket.active) socket.connect();
    }, delay);
  }

  /** A new connection has no rooms: forget the old connection's (and its pending acks). */
  private resetRooms(): void {
    this.epoch += 1;
    for (const [ticketId, room] of this.rooms) {
      this.clearRoomRetry(room);
      room.retries = 0;
      if (room.holders === 0) {
        this.rooms.delete(ticketId);
        continue;
      }
      room.joined = false;
      room.pending = null;
      room.refused = false;
    }
  }

  private readonly onConnect = (): void => {
    const isReconnect = this.everConnected;
    this.everConnected = true;
    this.attempts = 0;
    this.clearRetry();
    this.resetRooms();
    this.setStatus('connected');
    const epoch = this.epoch;
    const joins = [...this.rooms.keys()].map((ticketId) => this.syncRoom(ticketId));
    if (!isReconnect) return;
    // Refetch only once the rooms are joined again: a fetch answered before a join could miss
    // what is stored between the two.
    void Promise.all(joins).then(() => {
      if (epoch !== this.epoch || !this.socket?.connected) return; // a newer connection runs its own
      this.notify(this.reconnectListeners);
    });
  };

  private readonly onDisconnect = (reason: string): void => {
    this.resetRooms();
    if (!this.socket || reason === 'io client disconnect') return;
    this.setStatus('reconnecting');
    // The server closed it (token expired / sessions revoked): Socket.IO won't retry on its own.
    if (reason === 'io server disconnect') {
      this.forceRefresh = true;
      this.scheduleReconnect();
    }
  };

  private readonly onConnectError = (error: Error): void => {
    if (!this.socket) return;
    if (error.message === 'FORBIDDEN') {
      this.setStatus('forbidden');
      const socket = this.socket;
      this.socket = null;
      socket.off();
      socket.disconnect();
      return;
    }
    if (this.signedOut) {
      this.stop();
      return;
    }
    this.setStatus('reconnecting');
    // Transport errors: Socket.IO retries by itself (`active`). A refused handshake
    // (UNAUTHENTICATED: expired / revoked token) needs a fresh token and a manual retry.
    if (!this.socket.active) {
      this.forceRefresh = true;
      this.scheduleReconnect();
    }
  };
}

let shared: RealtimeClient | null = null;

/** The tab's realtime client (browser only; null on the server or without NEXT_PUBLIC_API_URL). */
export function getRealtimeClient(): RealtimeClient | null {
  if (typeof window === 'undefined') return null;
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) return null;
  shared ??= new RealtimeClient({ url, getToken: (options) => getApiToken(options) });
  return shared;
}
