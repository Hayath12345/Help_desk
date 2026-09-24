import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { errors } from '../lib/errors.ts';
import { globalRateLimitKey } from '../lib/internal-auth.ts';

export const GLOBAL_RATE_LIMIT = { max: 300, windowMs: 60_000 } as const;

/**
 * Helmet headers, strict CORS and the global Redis-backed rate limit (300/min per IP; the web
 * server's calls on a user's behalf count against that user's IP, see `globalRateLimitKey`).
 */
export async function registerSecurity(
  app: FastifyInstance,
  options: { rateLimitNamespace: string },
): Promise<void> {
  const { config } = app;

  await app.register(helmet, {
    global: true,
    // The API is fetched cross-origin by the web app (same site in every environment).
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: true,
    maxAge: 600,
    strictPreflight: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT.max,
    timeWindow: GLOBAL_RATE_LIMIT.windowMs,
    redis: app.redis,
    nameSpace: options.rateLimitNamespace,
    keyGenerator: (req) => globalRateLimitKey(req, config.internalApiKey),
    // Redis outage: keep serving (fail open) rather than rejecting every request.
    skipOnError: true,
    errorResponseBuilder: (_req, context) =>
      errors.rateLimited(Math.max(1, Math.ceil(context.ttl / 1000))),
    onExceeded: (req) => {
      req.log.warn({ limit: 'global' }, 'rate limit exceeded');
    },
  });
}
