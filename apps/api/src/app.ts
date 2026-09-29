import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { getDummyPasswordHash, type PrismaClient } from '@loons/db';
import { fastifyTrustProxy, type AppConfig } from './config.ts';
import { createPrincipalStore, type PrincipalStore } from './lib/actor.ts';
import { BackgroundTasks } from './lib/background.ts';
import type { EmailProvider } from './lib/email/index.ts';
import { loggerOptions } from './lib/logger.ts';
import type { AppQueues } from './lib/queues.ts';
import { createStorage, type Storage } from './lib/storage.ts';
import { createAccessTokenVerifier } from './lib/tokens.ts';
import type { UploadQuotaOptions } from './lib/upload-quota.ts';
import { registerDocs } from './plugins/docs.ts';
import { registerErrorHandling } from './plugins/error-handler.ts';
import { registerSecurity } from './plugins/security.ts';
import type { RealtimeLimits } from './realtime/limits.ts';
import { attachRealtime } from './realtime/socket.ts';
import { attachWorkerBridge } from './realtime/worker-bridge.ts';
import { attachmentRoutes } from './routes/attachments.ts';
import { configRoutes } from './routes/config.ts';
import { healthRoutes } from './routes/health.ts';
import { internalAuthRoutes } from './routes/internal/auth.ts';
import { meRoutes } from './routes/me.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { staffRoutes } from './routes/staff.ts';
import { ticketRoutes } from './routes/tickets.ts';
import { createServices } from './services/index.ts';
import { sharedSlaMath, type SlaMath } from './services/sla.ts';
import type { TicketRealtime } from './services/ticket-access.ts';
import './types.ts';

export const BODY_LIMIT_BYTES = 1024 * 1024;

/** A caller-supplied x-request-id is reused only if it looks like an id (no log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

class ApiLogController extends LogController {
  constructor() {
    super({
      requestIdLogLabel: 'requestId',
      // Probes would drown the logs.
      disableRequestLogging: (req: FastifyRequest) =>
        req.url === '/health' || req.url === '/health/live',
    });
  }
}

export interface AppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  redis: Redis;
  queues: AppQueues;
  /** Optional direct sender (the API normally queues emails for the worker). */
  emailProvider?: EmailProvider;
  /** Overrides for tests. */
  principals?: PrincipalStore;
  rateLimitNamespace?: string;
  /** Object storage (default: S3 / MinIO from config). */
  storage?: Storage;
  /** SLA due-date arithmetic (default: @loons/shared). */
  sla?: SlaMath;
  /** Socket limits (default: DEFAULT_REALTIME_LIMITS with the REALTIME_* config); tests lower them. */
  realtimeLimits?: Partial<RealtimeLimits>;
  /**
   * Longest wait for the other API instances when a ticket update re-checks its room (default
   * DEFAULT_CLUSTER_TIMEOUT_MS, 1 s).
   */
  realtimeClusterTimeoutMs?: number;
  /** Upload budget window / clock (default 24 h, Redis TIME); tests shorten or fake them. */
  uploadQuota?: Pick<UploadQuotaOptions, 'windowMs' | 'now'>;
  /** Length of an escalation "minute" when scheduling P1 steps (default 60 000 ms; tests shrink it). */
  escalationMinuteMs?: number;
}

/** Builds the Fastify app (routes, plugins, Socket.IO) without listening. */
export async function buildApp(deps: AppDeps) {
  const { config } = deps;

  const app = Fastify({
    logger: loggerOptions(config, 'api'),
    logController: new ApiLogController(),
    genReqId: requestIdFor,
    requestIdHeader: false,
    trustProxy: fastifyTrustProxy(config.trustProxy),
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const background = new BackgroundTasks(app.log);
  const principalStore =
    deps.principals ??
    createPrincipalStore({
      prisma: deps.prisma,
      redis: deps.redis,
      prefix: config.redisPrefix,
      logger: app.log,
    });
  // A principal is invalidated whenever the user changes (status, role, teams, sessions…): their
  // live sockets are re-checked at the same time, so a lost permission also closes the realtime
  // rooms it gave (review SEC-RT-2; Phase 4 member edits get this for free).
  const principals: PrincipalStore = {
    load: (userId, options) => principalStore.load(userId, options),
    async invalidate(userId) {
      await principalStore.invalidate(userId);
      if (!app.hasDecorator('realtime')) return;
      try {
        await app.realtime.refreshUser(userId);
      } catch (err) {
        app.log.error({ err }, 'could not refresh the sockets of a user');
      }
    },
  };

  app.decorate('config', config);
  app.decorate('prisma', deps.prisma);
  app.decorate('redis', deps.redis);
  app.decorate('queues', deps.queues);
  app.decorate('emailProvider', deps.emailProvider ?? null);
  app.decorate('tokens', createAccessTokenVerifier(config.jwt));
  app.decorate('principals', principals);
  app.decorate('background', background);
  const storage = deps.storage ?? createStorage(config.s3);
  app.decorate('storage', storage);
  // `realtime` is attached below; ticket events are only emitted once requests are served.
  const ticketRealtime: TicketRealtime = {
    messageNew: (message) => app.realtime.tickets.messageNew(message),
    ticketUpdated: (ticket, previous) => app.realtime.tickets.ticketUpdated(ticket, previous),
    queueUpdated: (teamIds, ticketId, reason) =>
      app.realtime.tickets.queueUpdated(teamIds, ticketId, reason),
  };
  app.decorate(
    'services',
    createServices({
      prisma: deps.prisma,
      redis: deps.redis,
      queues: deps.queues,
      principals,
      // `realtime` is attached below; revocations only happen once requests are served.
      sockets: { disconnectUser: (userId) => app.realtime.disconnectUser(userId) },
      ticketRealtime,
      storage,
      sla: deps.sla ?? sharedSlaMath,
      config,
      logger: app.log,
      uploadQuota: deps.uploadQuota,
      escalationMinuteMs: deps.escalationMinuteMs,
    }),
  );
  app.decorateRequest('actor', null);
  app.decorateRequest('internalCaller', false);

  // Echo the request id on every response (set first so errors carry it too).
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await registerSecurity(app, {
    rateLimitNamespace: deps.rateLimitNamespace ?? `${config.redisPrefix}rl:`,
  });
  registerErrorHandling(app);
  await registerDocs(app);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(internalAuthRoutes, { prefix: '/internal/auth' });
  await app.register(configRoutes);
  await app.register(ticketRoutes);
  await app.register(attachmentRoutes);
  await app.register(staffRoutes);
  await app.register(notificationRoutes);

  app.decorate(
    'realtime',
    attachRealtime(app, {
      ...(deps.realtimeLimits ? { limits: deps.realtimeLimits } : {}),
      ...(deps.realtimeClusterTimeoutMs !== undefined
        ? { clusterTimeoutMs: deps.realtimeClusterTimeoutMs }
        : {}),
    }),
  );
  // Worker events (SLA flags, escalation, auto-close, in-app notifications) → sockets (D14).
  attachWorkerBridge(app);

  // Let queued post-response work (e.g. reset emails) finish before shutting down.
  app.addHook('onClose', async () => {
    await background.drain();
  });

  // Pre-compute the dummy argon2 hash so the first unknown-email login isn't measurably slower.
  void getDummyPasswordHash();

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
