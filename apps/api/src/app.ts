import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { getDummyPasswordHash, type PrismaClient } from '@loons/db';
import { fastifyTrustProxy, type AppConfig } from './config.ts';
import { createPrincipalStore, type PrincipalStore } from './lib/actor.ts';
import { BackgroundTasks } from './lib/background.ts';
import type { EmailProvider } from './lib/email/index.ts';
import { loggerOptions } from './lib/logger.ts';
import type { AppQueues } from './lib/queues.ts';
import { createAccessTokenVerifier } from './lib/tokens.ts';
import { registerDocs } from './plugins/docs.ts';
import { registerErrorHandling } from './plugins/error-handler.ts';
import { registerSecurity } from './plugins/security.ts';
import { attachRealtime } from './realtime/socket.ts';
import { healthRoutes } from './routes/health.ts';
import { internalAuthRoutes } from './routes/internal/auth.ts';
import { meRoutes } from './routes/me.ts';
import { createServices } from './services/index.ts';
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
      disableRequestLogging: (req: FastifyRequest) => req.url === '/health' || req.url === '/health/live',
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
  const principals =
    deps.principals ??
    createPrincipalStore({ prisma: deps.prisma, redis: deps.redis, prefix: config.redisPrefix, logger: app.log });

  app.decorate('config', config);
  app.decorate('prisma', deps.prisma);
  app.decorate('redis', deps.redis);
  app.decorate('queues', deps.queues);
  app.decorate('emailProvider', deps.emailProvider ?? null);
  app.decorate('tokens', createAccessTokenVerifier(config.jwt));
  app.decorate('principals', principals);
  app.decorate('background', background);
  app.decorate(
    'services',
    createServices({
      prisma: deps.prisma,
      queues: deps.queues,
      principals,
      // `realtime` is attached below; revocations only happen once requests are served.
      sockets: { disconnectUser: (userId) => app.realtime.disconnectUser(userId) },
      config,
      logger: app.log,
    }),
  );
  app.decorateRequest('actor', null);
  app.decorateRequest('internalCaller', false);

  // Echo the request id on every response (set first so errors carry it too).
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await registerSecurity(app, { rateLimitNamespace: deps.rateLimitNamespace ?? `${config.redisPrefix}rl:` });
  registerErrorHandling(app);
  await registerDocs(app);

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(internalAuthRoutes, { prefix: '/internal/auth' });

  app.decorate('realtime', attachRealtime(app));

  // Let queued post-response work (e.g. reset emails) finish before shutting down.
  app.addHook('onClose', async () => {
    await background.drain();
  });

  // Pre-compute the dummy argon2 hash so the first unknown-email login isn't measurably slower.
  void getDummyPasswordHash();

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
