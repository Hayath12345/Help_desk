import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { canJoinUserRoom, isActive, rooms, type Actor, type RoomName } from '@loons/shared';
import { toActor } from '../lib/actor.ts';
import { AppError } from '../lib/errors.ts';
import { closeRedis } from '../lib/redis.ts';
import { authenticateToken } from '../plugins/auth.ts';

// Socket.IO on the API's HTTP server (same port, path /socket.io). engine.io handles these
// requests before Fastify, so Fastify hooks / CORS / rate limits don't apply: auth and origin
// checks are done here. Phase 1 has no client events: sockets only auto-join `user:{id}`.
//
// The token is verified once, at the handshake. A socket is closed when that token expires (the
// client reconnects with a fresh one) and when the user's sessions are revoked (`disconnectUser`).

export const SOCKET_PATH = '/socket.io';

/** Events the server emits (typed per event from Phase 2 on). */
export type ServerToClientEvents = Record<string, (payload: unknown) => void>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClientToServerEvents {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InterServerEvents {}
export interface SocketData {
  actor: Actor;
  /** When the handshake token stops being accepted (epoch ms). */
  tokenExpiresAt: number;
}

/** setTimeout's upper bound (~24.8 days); token lifetimes are far shorter. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type AppSocketServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

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
}

export function attachRealtime(app: FastifyInstance): Realtime {
  const { config } = app;
  const allowedOrigins = new Set(config.corsOrigins);

  const io: AppSocketServer = new Server(app.server, {
    path: SOCKET_PATH,
    serveClient: false,
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    },
    // WebSocket upgrades bypass CORS: reject browser origins that aren't allowed. Non-browser
    // clients send no Origin; they still need a valid token.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || allowedOrigins.has(origin));
    },
    maxHttpBufferSize: 1_000_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  let adapterClients: Redis[] = [];
  if (config.socketRedisAdapter) {
    const pub = app.redis.duplicate();
    const sub = app.redis.duplicate();
    for (const client of [pub, sub]) client.on('error', () => undefined);
    adapterClients = [pub, sub];
    io.adapter(createAdapter(pub, sub, { key: `${config.redisPrefix}socket.io` }));
  }

  // Handshake: `auth: { token }` verified exactly like HTTP (jose + DB reload).
  io.use((socket, next) => {
    const raw: unknown = socket.handshake.auth?.token;
    authenticateToken(app, typeof raw === 'string' ? raw : null)
      .then(({ principal, expiresAt }) => {
        const actor = toActor(principal);
        // Pending approval, or a client who hasn't verified their email yet.
        if (!isActive(actor)) return next(new Error('FORBIDDEN'));
        socket.data.actor = actor;
        socket.data.tokenExpiresAt = expiresAt;
        next();
      })
      .catch((err: unknown) => {
        if (!(err instanceof AppError)) app.log.error({ err }, 'socket authentication failed');
        next(new Error('UNAUTHENTICATED'));
      });
  });

  io.on('connection', (socket) => {
    const actor = socket.data.actor;
    if (canJoinUserRoom(actor, actor.id)) void socket.join(rooms.user(actor.id));

    const expiresIn = Math.min(Math.max(0, socket.data.tokenExpiresAt - Date.now()), MAX_TIMER_MS);
    const expiry = setTimeout(() => socket.disconnect(true), expiresIn);
    expiry.unref();
    socket.once('disconnect', () => clearTimeout(expiry));
  });

  // Must run in preClose: with sockets still open, closing the HTTP server would hang.
  app.addHook('preClose', async () => {
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
  };
}
