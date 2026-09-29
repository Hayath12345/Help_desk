// Socket limits (review SEC-RT-1, re-review RR-SEC-1 / RR-SEC-2). engine.io handles socket
// traffic before Fastify, so the HTTP rate limits never see it: each `ticket:join` reads the user
// and the ticket from Redis / Postgres, each handshake verifies a JWT and loads the principal, and
// every event — even one that is refused — costs CPU. One account (or one address) could otherwise
// flood the database from any number of sockets. Limits apply per API instance (a socket lives on
// one instance; the Redis adapter doesn't move them). Per-address limits key on `addressKey`
// (lib/client-address.ts): IPv4-mapped IPv6 as IPv4, other IPv6 by its /64.

/** A token bucket: `burst` events at once, refilled at `perSecond`. */
export interface RateLimit {
  burst: number;
  perSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly limit: RateLimit,
    now = Date.now(),
  ) {
    this.tokens = limit.burst;
    this.last = now;
  }

  private refill(now: number): void {
    const elapsedSeconds = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.limit.burst, this.tokens + elapsedSeconds * this.limit.perSecond);
    this.last = now;
  }

  /** Spends one token; false (nothing spent) when the bucket is empty. */
  take(now = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Back to its full burst (forgetting it changes nothing). */
  isFull(now = Date.now()): boolean {
    this.refill(now);
    return this.tokens >= this.limit.burst;
  }
}

export interface RealtimeLimits {
  /**
   * `ticket:join` per socket. The web joins up to 50 list rows at once and re-joins them when the
   * list changes (a leave + join per row), so the burst covers a few such changes in a row.
   */
  joinPerSocket: RateLimit;
  /** `ticket:join` per user, shared by all their sockets on this instance. */
  joinPerUser: RateLimit;
  /** `ticket:leave` per socket (no database work; generous). */
  leavePerSocket: RateLimit;
  /**
   * Every incoming event per socket, whatever its name (review RR-SEC-2): the budgets above only
   * cover the events that have one, and a refused event — malformed, not permitted, unknown —
   * still costs CPU. At least the sum of the bursts above, so the legitimate flows never hit it.
   */
  eventsPerSocket: RateLimit;
  /**
   * Every engine.io packet a connection sends, whatever its type, for as long as it is open:
   * acknowledgements, pongs, CONNECTs and events alike (review RR-SEC-2 — below the event layer
   * nothing else counts them). Well above what the event budget and the drop allowance let
   * through (500 + 500 at once, 80 + 50 per second) plus a pong every 25 s, so the event layer
   * always acts first on events; the connection is closed when it runs dry.
   */
  packetsPerConnection: RateLimit;
  /** Concurrent sockets per user (tabs, plus old sockets not yet timed out after a reconnect). */
  socketsPerUser: number;
  /** Concurrent sockets per client address (offices behind one NAT share it). */
  socketsPerIp: number;
  /**
   * New connections (engine.io handshakes) per client address, refused at the HTTP upgrade —
   * before the Socket.IO handshake verifies a token or loads a principal (review RR-SEC-1).
   * Sized for an office behind one NAT reconnecting after an API restart.
   */
  handshakesPerIp: RateLimit;
  /**
   * engine.io connections per client address that haven't completed a Socket.IO handshake yet
   * (open, but no successful CONNECT): refused at the HTTP upgrade beyond this. They count against
   * no other cap until they connect (review RR-SEC-1).
   */
  pendingConnectionsPerIp: number;
  /**
   * How long a connection may stay open without a successful handshake (Socket.IO's own
   * `connectTimeout` is 45 s by default). It is closed and discarded then — a polling one at once,
   * not after engine.io's 30 s close timeout (round-2 verify). The web client sends its CONNECT as
   * soon as the transport is open.
   */
  connectTimeoutMs: number;
  /**
   * Largest engine.io payload a client may send: one websocket frame, or one polling POST body
   * (refused with 413 before it is decoded). The web sends a CONNECT with its token and small
   * `ticket:join` / `ticket:leave` / `message:typing` events; a 1 MB POST used to be decoded whole
   * (about 500 000 packets) before any per-packet check ran (round-2 verify).
   */
  maxPayloadBytes: number;
  /**
   * Websocket upgrade attempts per polling session. An upgrade request carries the session's id,
   * so engine.io never runs `allowRequest` for it; a client tries once (round-2 verify: one session
   * opened 400 upgrade websockets in a row). The session is closed beyond this.
   */
  upgradesPerConnection: number;
  /**
   * Refused Socket.IO handshakes after which the engine.io connection is closed. Socket.IO runs
   * the handshake middleware for every CONNECT packet a connection sends until one succeeds and
   * leaves the connection open after a refusal, so one websocket could otherwise stream CONNECTs
   * (review RR-SEC-1). The web client opens a new connection after a refusal anyway.
   */
  handshakeFailuresPerConnection: number;
  /**
   * Events one socket may have refused (RATE_LIMITED, malformed, not permitted, TOO_MANY_ROOMS)
   * before it is disconnected: a flood keeps costing CPU even when every event is refused. A token
   * bucket — `dropsBeforeDisconnect` at once, refilled at `dropsBeforeDisconnect` per
   * `dropWindowMs` — so no window boundary doubles the allowance.
   */
  dropsBeforeDisconnect: number;
  dropWindowMs: number;
}

export const DEFAULT_REALTIME_LIMITS: RealtimeLimits = {
  joinPerSocket: { burst: 150, perSecond: 15 },
  joinPerUser: { burst: 300, perSecond: 30 },
  leavePerSocket: { burst: 300, perSecond: 60 },
  eventsPerSocket: { burst: 500, perSecond: 80 },
  packetsPerConnection: { burst: 2000, perSecond: 200 },
  socketsPerUser: 20,
  socketsPerIp: 500,
  handshakesPerIp: { burst: 200, perSecond: 20 },
  pendingConnectionsPerIp: 50,
  connectTimeoutMs: 10_000,
  maxPayloadBytes: 16_384,
  upgradesPerConnection: 3,
  handshakeFailuresPerConnection: 1,
  dropsBeforeDisconnect: 500,
  dropWindowMs: 10_000,
};

/**
 * Counts refused events in a token bucket (`max` at once, refilled at `max` per `windowMs`); true
 * once the bucket is empty, i.e. from the (max + 1)th refusal of a burst on. A sliding allowance:
 * `max` refusals just before and `max` just after any instant never both pass (re-review: the old
 * fixed window let 2 × max through at a window boundary).
 */
export class DropCounter {
  private readonly bucket: TokenBucket;

  constructor(max: number, windowMs: number, now = Date.now()) {
    this.bucket = new TokenBucket({ burst: max, perSecond: max / (windowMs / 1000) }, now);
  }

  record(now = Date.now()): boolean {
    return !this.bucket.take(now);
  }
}

/** Connection error message when a user or address has too many sockets open. */
export const TOO_MANY_CONNECTIONS = 'TOO_MANY_CONNECTIONS';
/** Connection error message when a connection sends CONNECT packets faster than they are answered. */
export const TOO_MANY_HANDSHAKES = 'TOO_MANY_HANDSHAKES';
/** Upgrade refusal when an address has too many connections that haven't completed a handshake. */
export const TOO_MANY_PENDING = 'TOO_MANY_PENDING_CONNECTIONS';
/** Middleware refusal of an upgrade request beyond `upgradesPerConnection` (HTTP 400). */
export const TOO_MANY_UPGRADES = 'TOO_MANY_UPGRADES';
/** Middleware refusal of a POST to a session that is closing: its packets would be dropped. */
export const SESSION_CLOSING = 'SESSION_CLOSING';

interface UserEntry {
  sockets: Set<string>;
  join: TokenBucket;
}

/**
 * Tracks this instance's sockets per user / address, connections per address that haven't
 * completed a handshake, the per-user join budget and the per-address handshake budget. A user's
 * budget outlives their sockets until it has refilled, so reconnecting doesn't reset it. Addresses
 * are the callers' keys (`addressKey`).
 */
export class ConnectionLimiter {
  private readonly users = new Map<string, UserEntry>();
  private readonly addresses = new Map<string, Set<string>>();
  private readonly handshakes = new Map<string, TokenBucket>();
  private readonly pending = new Map<string, Set<object>>();

  constructor(readonly limits: RealtimeLimits) {}

  /** Forgets users without sockets and addresses whose budgets have refilled (call now and then). */
  prune(now = Date.now()): void {
    for (const [userId, entry] of this.users) {
      if (entry.sockets.size === 0 && entry.join.isFull(now)) this.users.delete(userId);
    }
    for (const [address, bucket] of this.handshakes) {
      if (bucket.isFull(now)) this.handshakes.delete(address);
    }
  }

  /**
   * Spends one of the address's handshake tokens (false: too many new connections from it). Called
   * for every new connection, before any of its packets is read.
   */
  takeHandshake(address: string, now = Date.now()): boolean {
    let bucket = this.handshakes.get(address);
    if (!bucket) {
      bucket = new TokenBucket(this.limits.handshakesPerIp, now);
      this.handshakes.set(address, bucket);
    }
    return bucket.take(now);
  }

  /** Whether the address already has its maximum of connections without a handshake. */
  atPendingCap(address: string): boolean {
    return (this.pending.get(address)?.size ?? 0) >= this.limits.pendingConnectionsPerIp;
  }

  /** Counts a new connection of the address until `settlePending` (its handshake or its close). */
  addPending(address: string, connection: object): void {
    const set = this.pending.get(address);
    if (set) set.add(connection);
    else this.pending.set(address, new Set([connection]));
  }

  /** Stops counting the connection as pending (idempotent). */
  settlePending(address: string, connection: object): void {
    const set = this.pending.get(address);
    if (set?.delete(connection) && set.size === 0) this.pending.delete(address);
  }

  /** Whether the address already has its maximum number of sockets (checked before any auth work). */
  atAddressCap(address: string): boolean {
    return this.count('address', address) >= this.limits.socketsPerIp;
  }

  /** Reserves a slot for a new socket; false when the user or address is at its cap. */
  admit(socketId: string, userId: string, address: string): boolean {
    const user = this.users.get(userId);
    const fromAddress = this.addresses.get(address);
    if ((user?.sockets.size ?? 0) >= this.limits.socketsPerUser) return false;
    if ((fromAddress?.size ?? 0) >= this.limits.socketsPerIp) return false;
    if (user) user.sockets.add(socketId);
    else {
      this.users.set(userId, {
        sockets: new Set([socketId]),
        join: new TokenBucket(this.limits.joinPerUser),
      });
    }
    if (fromAddress) fromAddress.add(socketId);
    else this.addresses.set(address, new Set([socketId]));
    return true;
  }

  /** Frees the socket's slot (idempotent). */
  release(socketId: string, userId: string, address: string): void {
    const user = this.users.get(userId);
    if (user?.sockets.delete(socketId) && user.sockets.size === 0 && user.join.isFull()) {
      this.users.delete(userId);
    }
    const fromAddress = this.addresses.get(address);
    if (fromAddress?.delete(socketId) && fromAddress.size === 0) this.addresses.delete(address);
  }

  /** Spends one of the user's join tokens (false: throttled). */
  takeJoin(userId: string): boolean {
    return this.users.get(userId)?.join.take() ?? true;
  }

  /** Open sockets of a user / an address (or pending connections of an address) on this instance. */
  count(kind: 'user' | 'address' | 'pending', key: string): number {
    if (kind === 'user') return this.users.get(key)?.sockets.size ?? 0;
    if (kind === 'pending') return this.pending.get(key)?.size ?? 0;
    return this.addresses.get(key)?.size ?? 0;
  }
}

/** Packets a connection may send before its handshake succeeded: the CONNECT and little else. */
export const PACKETS_BEFORE_CONNECT = 3;

interface ConnectionState {
  /** A handshake is being checked (the token verified, the principal loaded). */
  inFlight: boolean;
  failures: number;
  /** Message packets received while no handshake had succeeded. */
  packets: number;
  connected: boolean;
}

/**
 * Per engine.io connection: one Socket.IO handshake at a time, at most
 * `handshakeFailuresPerConnection` refused ones, at most `PACKETS_BEFORE_CONNECT` packets before
 * one succeeded (review RR-SEC-1), and no CONNECT at all once connected (review RR-SEC-2).
 * Socket.IO itself closes a connection that sends a CONNECT for a namespace it already joined,
 * but answers a CONNECT for an unknown namespace — without the handshake middleware — as often
 * as it is sent. Keyed weakly: nothing is kept after the connection closes.
 */
export class HandshakeGate {
  private readonly connections = new WeakMap<object, ConnectionState>();

  constructor(private readonly maxFailures: number) {}

  private stateOf(connection: object): ConnectionState {
    let state = this.connections.get(connection);
    if (!state) {
      state = { inFlight: false, failures: 0, packets: 0, connected: false };
      this.connections.set(connection, state);
    }
    return state;
  }

  /**
   * Reserves the connection's handshake slot; false when a handshake is already being checked or
   * the connection has failed too many (the caller closes it either way).
   */
  begin(connection: object): boolean {
    const state = this.stateOf(connection);
    if (state.inFlight || state.failures >= this.maxFailures) return false;
    state.inFlight = true;
    return true;
  }

  /** Frees the slot; true when the connection has failed too often and must be closed. */
  end(connection: object, ok: boolean): boolean {
    const state = this.stateOf(connection);
    state.inFlight = false;
    if (ok) state.connected = true;
    else state.failures += 1;
    return state.failures >= this.maxFailures;
  }

  /**
   * Counts a message packet; false when the connection must be closed: an unconnected one sent
   * more than allowed, or a connected one sent a CONNECT (the web only uses the default
   * namespace, which it joined already).
   */
  packet(connection: object, isConnect = false): boolean {
    const state = this.stateOf(connection);
    if (state.connected) return !isConnect;
    state.packets += 1;
    return state.packets <= PACKETS_BEFORE_CONNECT;
  }
}

/** Whether an engine.io message is a Socket.IO CONNECT packet (type 0, any namespace). */
export function isConnectPacket(data: unknown): boolean {
  return typeof data === 'string' && data.startsWith('0');
}
