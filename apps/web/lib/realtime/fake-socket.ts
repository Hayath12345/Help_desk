// A minimal stand-in for a socket.io-client Socket, driven by tests (no network).

import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import type { ClientSocket, SocketFactory } from './client';

type Handler = (...args: unknown[]) => void;

export class FakeSocket {
  connected = false;
  /** socket.io-client's `active`: whether it will reconnect by itself. */
  active = false;
  readonly emitted: { event: string; payload: unknown; volatile: boolean }[] = [];
  readonly authTokens: string[] = [];
  connectCalls = 0;
  private handlers = new Map<string, Set<Handler>>();
  /** What the fake "server" answers to room joins. */
  joinAck: { ok: boolean; error?: string } = { ok: true };
  /** Answers for the next joins, used (in order) before `joinAck`. */
  readonly nextJoinAcks: { ok: boolean; error?: string }[] = [];
  /**
   * The server's ticket rooms cap (MAX_TICKET_ROOMS_PER_SOCKET): a join of a new room while the
   * socket is in this many is answered TOO_MANY_ROOMS, when it is handled.
   */
  maxRooms = Infinity;
  /**
   * When true, room requests wait in `heldAcks` until `deliverAcks()` answers them (in any order:
   * the order the "server" finished handling them). Otherwise they are answered at once.
   */
  holdAcks = false;
  readonly heldAcks: { event: string; ticketId: string; answer: () => void }[] = [];
  /** Rooms the fake server has this socket in (as the answered requests left it). */
  readonly serverRooms = new Set<string>();

  constructor(readonly options: Partial<ManagerOptions & SocketOptions>) {}

  on(event: string, handler: Handler) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return this;
  }

  off() {
    this.handlers.clear();
    return this;
  }

  /** Starts a handshake: asks for the auth payload (like the real client does). */
  connect() {
    this.connectCalls += 1;
    this.active = true;
    const auth = this.options.auth;
    if (typeof auth === 'function') {
      auth((data) => this.authTokens.push(String((data as { token?: unknown }).token ?? '')));
    }
    return this;
  }

  disconnect() {
    const was = this.connected;
    this.connected = false;
    this.active = false;
    this.serverRooms.clear();
    if (was) this.fire('disconnect', 'io client disconnect');
    return this;
  }

  timeout() {
    return {
      emit: (event: string, payload: unknown, ack?: (err: Error | null, res: unknown) => void) => {
        this.emitted.push({ event, payload, volatile: false });
        const ticketId = String((payload as { ticketId?: unknown } | null)?.ticketId ?? '');
        const answer = () => {
          if (event === 'ticket:join') {
            let res = this.nextJoinAcks.shift() ?? this.joinAck;
            if (
              res.ok &&
              !this.serverRooms.has(ticketId) &&
              this.serverRooms.size >= this.maxRooms
            ) {
              res = { ok: false, error: 'TOO_MANY_ROOMS' };
            }
            if (res.ok) this.serverRooms.add(ticketId);
            ack?.(null, res);
          } else {
            if (event === 'ticket:leave') this.serverRooms.delete(ticketId);
            ack?.(null, { ok: true });
          }
        };
        if (this.holdAcks) this.heldAcks.push({ event, ticketId, answer });
        else answer();
      },
    };
  }

  /**
   * Answers held room requests: all of them in arrival order, or those at `indexes` (positions
   * in `heldAcks`) in the given order, e.g. `[1, 0]` for a server that finished a slow join after
   * the leave sent behind it.
   */
  deliverAcks(indexes?: number[]) {
    const all = [...this.heldAcks];
    const picked = indexes ? indexes.map((i) => all[i]!) : all;
    for (const item of picked) this.heldAcks.splice(this.heldAcks.indexOf(item), 1);
    for (const item of picked) item.answer();
  }

  get volatile() {
    return {
      emit: (event: string, payload: unknown) => {
        this.emitted.push({ event, payload, volatile: true });
      },
    };
  }

  // ── test controls ──
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((handler) => handler(...args));
  }

  accept() {
    this.connected = true;
    this.active = true;
    this.fire('connect');
  }

  refuse(message: string) {
    this.connected = false;
    this.active = false;
    this.fire('connect_error', new Error(message));
  }

  serverClose() {
    this.connected = false;
    this.active = false;
    this.serverRooms.clear();
    this.fire('disconnect', 'io server disconnect');
  }

  transportClose() {
    this.connected = false;
    this.active = true;
    this.serverRooms.clear();
    this.fire('disconnect', 'transport close');
  }

  receive(event: string, payload: unknown) {
    this.fire(event, payload);
  }

  eventsNamed(name: string) {
    return this.emitted.filter((e) => e.event === name).map((e) => e.payload);
  }
}

/** A factory that records every socket it creates. */
export function fakeSocketFactory(): { factory: SocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (_url, options) => {
    const socket = new FakeSocket(options);
    sockets.push(socket);
    return socket as unknown as ClientSocket;
  };
  return { factory, sockets };
}
