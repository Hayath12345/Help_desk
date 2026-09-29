import type { IncomingMessage } from 'node:http';
import proxyAddr from '@fastify/proxy-addr';
import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { canJoinUserRoom, isActive, rooms, type Actor, type RoomName } from '@loons/shared';
import { fastifyTrustProxy, type TrustProxy } from '../config.ts';
import { toActor } from '../lib/actor.ts';
import { addressKey } from '../lib/client-address.ts';
import { AppError } from '../lib/errors.ts';
import { closeRedis } from '../lib/redis.ts';
import { authenticateToken } from '../plugins/auth.ts';
import type { TicketRealtime } from '../services/ticket-access.ts';
import {
  ConnectionLimiter,
  DEFAULT_REALTIME_LIMITS,
  DropCounter,
  HandshakeGate,
  SESSION_CLOSING,
  TOO_MANY_CONNECTIONS,
  TOO_MANY_HANDSHAKES,
  TOO_MANY_PENDING,
  TOO_MANY_UPGRADES,
  TokenBucket,
  isConnectPacket,
  type RealtimeLimits,
} from './limits.ts';
import {
  createTicketRealtime,
  joinTeamRooms,
  loadActiveActor,
  newTypingState,
  refreshUserSockets,
  registerTicketHandlers,
  usersWhoLostAccess,
  type TypingState,
} from './tickets.ts';

// Socket.IO on the API's HTTP server (same port, path /socket.io). engine.io handles these
// requests before Fastify, so Fastify hooks / CORS / rate limits don't apply: auth and origin
// checks are done here. Everyone joins `user:{id}`; staff join `team:{id}` for their teams
// (super admins: every active team); ticket rooms are joined with `ticket:join` (tickets.ts).
//
// The token is verified once, at the handshake. A socket is closed when that token expires (the
// client reconnects with a fresh one) and when the user's sessions are revoked (`disconnectUser`).
// When a user's access changes (`refreshUser`, run by every principal invalidation) their sockets
// get the new permissions and leave the rooms they may no longer be in. Sockets per user / address,
// handshakes and events are limited (limits.ts) — the handshake limits BEFORE any token is
// verified (review RR-SEC-1): a CONNECT packet costs a JWT verify and a principal load, Socket.IO
// runs the middleware for every CONNECT of a connection that hasn't joined yet, and a refused
// handshake leaves the connection open. Every packet of a connection, whatever its type, spends
// a per-connection token for as long as it is open, and a CONNECT after the handshake closes it
// (re-review RR-SEC-2: acks, pongs and CONNECTs for unknown namespaces reach no event handler).
// Per-address limits key on `addressKey` (IPv6 by /64, like the HTTP rate limits).
//
// Below Socket.IO (round-2 verify): payloads are capped at `maxPayloadBytes` (a polling POST is
// decoded whole before any per-packet check), upgrade websockets are limited per session and their
// probe pings budgeted (engine.io answers them itself, before any 'packet' event), and every close
// this module makes discards the transport — a polling connection closed without a GET
// outstanding otherwise stays 'closing' for engine.io's 30 s close timeout, still reading POSTs.
// POSTs to a closing session (Socket.IO's own closes still wait) are refused before they are read.

export const SOCKET_PATH = '/socket.io';

/**
 * Events the server emits. Payload types are the shared contract (`@loons/shared` realtime.ts);
 * emits go through the typed helpers in tickets.ts.
 */
export type ServerToClientEvents = Record<string, (payload: unknown) => void>;
/** Client → server events; payloads are untrusted and validated with the shared zod schemas. */
export interface ClientToServerEvents {
  'ticket:join': (payload: unknown, ack?: unknown) => void;
  'ticket:leave': (payload: unknown, ack?: unknown) => void;
  'message:typing': (payload: unknown, ack?: unknown) => void;
}
/** Between API instances (Redis adapter): re-check a user's sockets on every instance. */
export interface InterServerEvents {
  'user:refresh': (userId: string) => void;
}
export interface SocketData {
  actor: Actor;
  /** When the handshake token stops being accepted (epoch ms). */
  tokenExpiresAt: number;
  /** Display name for typing indicators (loaded on first use). */
  name?: string;
  typing: TypingState;
  /**
   * Client address key (behind TRUST_PROXY proxies: the forwarded address; IPv6 by its /64, see
   * `addressKey`), for the per-address cap.
   */
  address: string;
  /** Per-socket event budgets (`events`: every event; the others: that event only). */
  limits: { events: TokenBucket; join: TokenBucket; leave: TokenBucket; drops: DropCounter };
}

/** setTimeout's upper bound (~24.8 days); token lifetimes are far shorter. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The engine.io connection under a socket (one per websocket / polling session). */
type EngineConnection = AppSocket['conn'];

/** What this module tracks per engine.io connection (see the 'connection' hook). */
interface Session {
  conn: EngineConnection;
  /** Websocket upgrade requests made with this session's id. */
  upgrades: number;
  /** Upgrade transports that have sent their probe ping (a client sends one per upgrade). */
  probed: WeakSet<object>;
  /** Packets written but not handed to a transport yet (a polling client without a GET). */
  unsent: number;
  /** Closes the connection when no handshake has succeeded in time. */
  connectTimer: NodeJS.Timeout;
}

/** How long a refused handshake's CONNECT_ERROR may wait for the client to fetch it. */
const REPLY_GRACE_MS = 2_000;
/**
 * Socket.IO's own connect timeout, after ours (`connectTimeoutMs`): a backstop only, since it
 * closes without discarding the transport.
 */
const SOCKET_IO_CONNECT_TIMEOUT_MARGIN_MS = 5_000;

export type AppSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface Realtime {
  io: AppSocketServer;
  /** Emit to every socket in a room (across API instances when the Redis adapter is on). */
  emitToRoom(room: RoomName, event: string, payload: unknown): void;
  emitToUser(userId: string, event: string, payload: unknown): void;
  /**
   * Closes every live socket of the user, on every API instance when the Redis adapter is on.
   * Call after revoking their sessions (sessionVersion bump).
   */
  disconnectUser(userId: string): void;
  /**
   * Re-checks the user's live sockets after their access changed — team membership, role or
   * status (Phase 4 member edits): disconnects them when the user may no longer use the app,
   * otherwise refreshes their permissions and team rooms and evicts them from tickets they can no
   * longer see. On this instance before resolving; on the others shortly after (Redis adapter).
   * Every `principals.invalidate` of the API runs it (app.ts), so any change that invalidates the
   * principal — as every change to a user must — is covered.
   */
  refreshUser(userId: string): Promise<void>;
  /** Ticket events (message:new, ticket:updated, queue:updated), emitted after each commit. */
  tickets: TicketRealtime;
}

/** The client address of a handshake, honouring TRUST_PROXY like Fastify's `request.ip`. */
export function clientAddressResolver(trustProxy: TrustProxy): (req: IncomingMessage) => string {
  const trust = fastifyTrustProxy(trustProxy);
  const trustFn =
    typeof trust === 'function'
      ? trust
      : trust === true
        ? () => true
        : trust === false
          ? () => false
          : proxyAddr.compile(trust);
  return (req) => {
    try {
      return proxyAddr(req, trustFn);
    } catch {
      return req.socket.remoteAddress ?? 'unknown';
    }
  };
}

/**
 * Longest wait for the other API instances' answer when a ticket update re-checks its room (the
 * Redis adapter's own request timeout is 5 s, and the update's request waits for the re-check).
 */
export const DEFAULT_CLUSTER_TIMEOUT_MS = 1_000;

export function attachRealtime(
  app: FastifyInstance,
  options: {
    /** Overrides (tests); otherwise DEFAULT_REALTIME_LIMITS with the REALTIME_* config. */
    limits?: Partial<RealtimeLimits>;
    /** See DEFAULT_CLUSTER_TIMEOUT_MS. */
    clusterTimeoutMs?: number;
  } = {},
): Realtime {
  const { config } = app;
  const allowedOrigins = new Set(config.corsOrigins);
  const limits: RealtimeLimits = {
    ...DEFAULT_REALTIME_LIMITS,
    ...config.realtime,
    ...options.limits,
  };
  const limiter = new ConnectionLimiter(limits);
  const gate = new HandshakeGate(limits.handshakeFailuresPerConnection);
  const resolveAddress = clientAddressResolver(config.trustProxy);
  /** The key of a request's client address for the per-address limits. */
  const addressOf = (req: IncomingMessage) => addressKey(resolveAddress(req));
  const pruneTimer = setInterval(() => limiter.prune(), 60_000);
  pruneTimer.unref();

  const io: AppSocketServer = new Server(app.server, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    },
    // Runs once per new connection (the upgrade, or the first polling request), before a single
    // packet is read. WebSocket upgrades bypass CORS: reject browser origins that aren't allowed
    // (non-browser clients send no Origin; they still need a valid token). Then the address's
    // connections without a handshake yet (they count against no other cap), then its handshake
    // budget: a flood of connections is refused here with a 403 — no engine.io socket, no
    // Socket.IO client, no token verified — and a client backs off (review RR-SEC-1). engine.io
    // creates the connection synchronously after this callback, and the 'connection' hook below
    // counts it as pending before another request is looked at.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return callback('origin not allowed', false);
      const address = addressOf(req);
      if (limiter.atPendingCap(address)) return callback(TOO_MANY_PENDING, false);
      if (!limiter.takeHandshake(address)) return callback(TOO_MANY_HANDSHAKES, false);
      callback(null, true);
    },
    // A connection without a successful handshake is closed by the 'connection' hook below after
    // connectTimeoutMs (discarding its transport); Socket.IO's timer (45 s by default) is a
    // backstop.
    connectTimeout: limits.connectTimeoutMs + SOCKET_IO_CONNECT_TIMEOUT_MARGIN_MS,
    maxHttpBufferSize: limits.maxPayloadBytes,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  /** Open engine.io connections by session id, and by connection. */
  const sessions = new Map<string, Session>();
  const sessionOf = new WeakMap<EngineConnection, Session>();

  /**
   * Closes a connection now, discarding its transport: a polling one is gone at once (its pending
   * slot freed, later requests answered 400 unknown sid) instead of staying 'closing' for
   * engine.io's 30 s close timeout when no GET is outstanding (round-2 verify).
   */
  const closeNow = (conn: EngineConnection) => {
    conn.close(true);
  };

  /**
   * Closes a connection after its CONNECT_ERROR went out: Socket.IO writes the error on the next
   * tick and skips it when the connection is no longer open — so a client still learns why it was
   * refused (the web client refreshes its token on UNAUTHENTICATED and gives up on FORBIDDEN)
   * before the connection goes away. A polling client without a GET outstanding gets
   * REPLY_GRACE_MS to fetch it.
   */
  const closeAfterReply = (conn: EngineConnection) => {
    setImmediate(() => {
      if (conn.readyState !== 'open') return;
      const session = sessionOf.get(conn);
      if (!session || session.unsent === 0) return closeNow(conn);
      const grace = setTimeout(() => closeNow(conn), REPLY_GRACE_MS);
      conn.once('drain', () => {
        clearTimeout(grace);
        closeNow(conn);
      });
      conn.once('close', () => clearTimeout(grace));
    });
  };

  // Runs for every engine.io request, before `allowRequest` and before a body is read. Requests
  // with a session id skip `allowRequest`: a POST to a session that is closing (Socket.IO's own
  // closes wait for the client's next GET, up to 30 s) is refused unread — its packets would be
  // dropped anyway — and websocket upgrades are limited per session (round-2 verify).
  io.engine.use((req: IncomingMessage, _res: unknown, next: (err?: unknown) => void) => {
    const query = new URL(req.url ?? '/', 'http://engine.invalid').searchParams;
    const sid = query.get('sid');
    const session = sid === null ? undefined : sessions.get(sid);
    if (!session) return next(); // a new connection (allowRequest), or unknown to engine.io too
    if (session.conn.readyState !== 'open') {
      return next(req.method === 'POST' ? new Error(SESSION_CLOSING) : undefined);
    }
    if (query.get('transport') === 'websocket') {
      session.upgrades += 1;
      if (session.upgrades > limits.upgradesPerConnection) {
        app.log.warn({ address: addressOf(req) }, 'socket closed: repeated upgrades');
        closeNow(session.conn);
        return next(new Error(TOO_MANY_UPGRADES));
      }
    }
    next();
  });

  // Every engine.io connection is counted as pending (per address) until its handshake succeeds
  // or it closes, and every packet it sends — whatever its type, for as long as it is open —
  // spends one of its tokens: acks, pongs and CONNECTs never reach the event budget (re-review
  // RR-SEC-2). Before the handshake succeeds a connection has nothing to say but its CONNECT:
  // anything more (CONNECTs for other namespaces — answered by Socket.IO without the middleware
  // below — or junk) closes it; after it, any CONNECT does (the web only uses the default
  // namespace). Prepended so the packet that closes the connection is not answered first. Probe
  // pings on an upgrade websocket never reach 'packet' (engine.io answers them itself): each spends
  // a token too, and a second one on the same websocket closes the connection (round-2 verify).
  io.engine.on('connection', (conn: EngineConnection) => {
    const address = addressOf(conn.request);
    const sid = conn.transport.sid;
    limiter.addPending(address, conn);
    const session: Session = {
      conn,
      upgrades: 0,
      probed: new WeakSet(),
      unsent: 0,
      connectTimer: setTimeout(() => {
        app.log.debug({ address }, 'socket closed: no handshake in time');
        closeNow(conn);
      }, limits.connectTimeoutMs),
    };
    sessions.set(sid, session);
    sessionOf.set(conn, session);
    conn.once('close', () => {
      clearTimeout(session.connectTimer);
      sessions.delete(sid);
      limiter.settlePending(address, conn);
    });
    conn.on('packetCreate', () => {
      session.unsent += 1;
    });
    conn.on('drain', () => {
      session.unsent = 0;
    });
    const packets = new TokenBucket(limits.packetsPerConnection);
    conn.prependListener('packet', () => {
      if (packets.take() || conn.readyState !== 'open') return;
      app.log.warn({ address }, 'socket closed: packet flood');
      closeNow(conn);
    });
    conn.prependListener('data', (data: unknown) => {
      if (gate.packet(conn, isConnectPacket(data)) || conn.readyState !== 'open') return;
      app.log.warn({ address }, 'socket closed: unexpected packet');
      closeNow(conn);
    });
    conn.on('upgrading', (transport: object) => {
      if (packets.take() && !session.probed.has(transport)) {
        session.probed.add(transport);
        return;
      }
      app.log.warn({ address }, 'socket closed: upgrade probe flood');
      closeNow(conn);
    });
  });

  let adapterClients: Redis[] = [];
  /** The Redis adapter's publishing connection (null without the adapter). */
  let publisher: Redis | null = null;
  if (config.socketRedisAdapter) {
    const pub = app.redis.duplicate();
    const sub = app.redis.duplicate();
    for (const client of [pub, sub]) client.on('error', () => undefined);
    adapterClients = [pub, sub];
    publisher = pub;
    io.adapter(createAdapter(pub, sub, { key: `${config.redisPrefix}socket.io` }));
  }

  // Handshake: `auth: { token }` verified exactly like HTTP (jose + DB reload) — once the
  // connection is allowed to: one CONNECT at a time, none after a refusal, none when the address
  // is at its socket cap (review RR-SEC-1). A refused handshake closes the connection after the
  // CONNECT_ERROR; the web client opens a new one (with a fresh token) when it retries.
  io.use((socket, next) => {
    const conn = socket.conn;
    const address = addressOf(socket.request);
    if (!gate.begin(conn)) {
      // A second CONNECT while the first is being checked (or after it was refused): a client
      // never does that. Closed at once, nothing checked.
      app.log.warn({ address }, 'socket closed: repeated CONNECT packets');
      closeNow(conn);
      return next(new Error(TOO_MANY_HANDSHAKES));
    }
    const refuse = (message: string) => {
      if (gate.end(conn, false)) closeAfterReply(conn);
      next(new Error(message));
    };
    if (limiter.atAddressCap(address)) return refuse(TOO_MANY_CONNECTIONS);

    const raw: unknown = socket.handshake.auth?.token;
    authenticateToken(app, typeof raw === 'string' ? raw : null)
      .then(({ principal, expiresAt }) => {
        const actor = toActor(principal);
        // Pending approval, or a client who hasn't verified their email yet.
        if (!isActive(actor)) return refuse('FORBIDDEN');
        // The client left while we were checking: socket.io drops it without a disconnect event.
        if (conn.readyState !== 'open') return refuse('UNAUTHENTICATED');
        if (!limiter.admit(socket.id, actor.id, address)) return refuse(TOO_MANY_CONNECTIONS);
        const release = () => limiter.release(socket.id, actor.id, address);
        conn.once('close', release);
        socket.once('disconnect', release);
        socket.data.actor = actor;
        socket.data.tokenExpiresAt = expiresAt;
        socket.data.typing = newTypingState();
        socket.data.address = address;
        socket.data.limits = {
          events: new TokenBucket(limits.eventsPerSocket),
          join: new TokenBucket(limits.joinPerSocket),
          leave: new TokenBucket(limits.leavePerSocket),
          drops: new DropCounter(limits.dropsBeforeDisconnect, limits.dropWindowMs),
        };
        gate.end(conn, true);
        limiter.settlePending(address, conn);
        const session = sessionOf.get(conn);
        if (session) clearTimeout(session.connectTimer);
        next();
      })
      .catch((err: unknown) => {
        if (!(err instanceof AppError)) app.log.error({ err }, 'socket authentication failed');
        refuse('UNAUTHENTICATED');
      });
  });

  io.on('connection', (socket) => {
    const actor = socket.data.actor;
    if (canJoinUserRoom(actor, actor.id)) void socket.join(rooms.user(actor.id));
    joinTeamRooms(app, socket).catch((err: unknown) => {
      app.log.error({ err }, 'could not join the team rooms');
    });
    registerTicketHandlers(app, socket, limiter);

    const expiresIn = Math.min(Math.max(0, socket.data.tokenExpiresAt - Date.now()), MAX_TIMER_MS);
    const expiry = setTimeout(() => socket.disconnect(true), expiresIn);
    expiry.unref();
    socket.once('disconnect', () => clearTimeout(expiry));
  });

  /** This instance's sockets of the user. */
  function localSocketsOf(userId: string): AppSocket[] {
    const nsp = io.of('/');
    return [...(nsp.adapter.rooms.get(rooms.user(userId)) ?? [])]
      .map((id) => nsp.sockets.get(id))
      .filter((s): s is AppSocket => s !== undefined);
  }

  const refreshLocal = (userId: string) => refreshUserSockets(app, localSocketsOf(userId), userId);
  if (config.socketRedisAdapter) {
    io.on('user:refresh', (userId) => {
      if (typeof userId !== 'string') return;
      refreshLocal(userId).catch((err: unknown) => {
        app.log.error({ err }, 'could not refresh the sockets of a user');
      });
    });
  }

  // Must run in preClose: with sockets still open, closing the HTTP server would hang.
  app.addHook('preClose', async () => {
    clearInterval(pruneTimer);
    io.local.disconnectSockets(true);
    await Promise.resolve(io.of('/').adapter.close());
    io.engine.close();
  });
  app.addHook('onClose', async () => {
    await Promise.all(adapterClients.map((c) => closeRedis(c)));
  });

  return {
    io,
    emitToRoom(room, event, payload) {
      io.to(room).emit(event, payload);
    },
    emitToUser(userId, event, payload) {
      io.to(rooms.user(userId)).emit(event, payload);
    },
    disconnectUser(userId) {
      io.in(rooms.user(userId)).disconnectSockets(true);
    },
    async refreshUser(userId) {
      if (config.socketRedisAdapter) io.serverSideEmit('user:refresh', userId);
      await refreshLocal(userId);
    },
    tickets: createTicketRealtime(io, {
      crossNode: config.socketRedisAdapter,
      onError: (err) => app.log.error({ err }, 'could not re-check ticket room members'),
      loadActor: (userId) => loadActiveActor(app, userId),
      usersWhoLostAccess: (previous, next) => usersWhoLostAccess(app.prisma, previous, next),
      clusterTimeoutMs: options.clusterTimeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS,
      // Redis answers a PING on the adapter's publishing connection only once every PUBLISH sent
      // on it before (room leaves, broadcasts) has been handed to the subscribers.
      ...(publisher ? { flush: () => publisher.ping() } : {}),
    }),
  };
}
