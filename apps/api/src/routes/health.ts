import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTimeout } from '../lib/redis.ts';

const CHECK_TIMEOUT_MS = 2_000;

const checkStatus = z.enum(['ok', 'down']);
const healthSchema = z.object({
  status: z.enum(['ok', 'error']),
  checks: z.object({ db: checkStatus, redis: checkStatus }),
  version: z.string(),
});

async function probe(check: () => Promise<unknown>, label: string): Promise<'ok' | 'down'> {
  try {
    await withTimeout(check(), CHECK_TIMEOUT_MS, label);
    return 'ok';
  } catch {
    return 'down';
  }
}

/** Load-balancer probes: not rate limited and not request-logged. */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Readiness: database and Redis reachable',
        response: { 200: healthSchema, 503: healthSchema },
      },
    },
    async (req, reply) => {
      const [db, redis] = await Promise.all([
        probe(() => app.prisma.$queryRaw`SELECT 1`, 'db'),
        probe(() => app.redis.ping(), 'redis'),
      ]);
      const ok = db === 'ok' && redis === 'ok';
      if (!ok) req.log.warn({ db, redis }, 'health check failing');
      return reply.code(ok ? 200 : 503).send({
        status: ok ? 'ok' : 'error',
        checks: { db, redis },
        version: app.config.version,
      });
    },
  );

  app.get(
    '/health/live',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['health'],
        summary: 'Liveness: the process is up (no dependency checks)',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
};
