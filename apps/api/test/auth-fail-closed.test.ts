import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '@loons/db';
import { apiErrorSchema } from '@loons/shared';
import { buildApp, type App } from '../src/app.ts';
import type { AppConfig } from '../src/config.ts';
import type { AppQueues } from '../src/lib/queues.ts';
import { LIMIT_CHECK_TIMEOUT_MS, STORE_DOWN_RETRY_AFTER_SECONDS, limitGuard } from '../src/lib/rate-limit.ts';
import { registerErrorHandling } from '../src/plugins/error-handler.ts';
import { Fixtures, TEST_PASSWORD, mintToken, randomIp, testConfig, testEmail } from './helpers.ts';

// Redis is unreachable: the per-route limits on /internal/auth/* fail CLOSED (503
// SERVICE_UNAVAILABLE), while the global limit and everything else keep working (fail open).

type StoreCallback = (err: Error | null, result?: unknown) => void;

/** A Redis client whose every command fails (or, with `hang`, whose rate-limit calls never answer). */
function unreachableRedis(options: { hang?: boolean } = {}): Redis {
  const down = () => Promise.reject(new Error('ECONNREFUSED'));
  const storeCommand = (...args: unknown[]) => {
    if (options.hang) return; // never calls back
    (args.at(-1) as StoreCallback)(new Error('ECONNREFUSED'));
  };
  return {
    ping: down,
    get: down,
    mget: down,
    set: down,
    del: down,
    eval: down,
    multi: () => ({ incr: () => ({ expire: () => ({ del: () => ({ exec: down }) }) }) }),
    defineCommand: () => undefined,
    // @fastify/rate-limit's Redis store commands (callback style).
    rateLimit: storeCommand,
    rateLimitRead: storeCommand,
  } as unknown as Redis;
}

const queuesStub = { close: async () => undefined } as unknown as AppQueues;

describe('auth rate limits fail closed when Redis is unreachable', () => {
  let config: AppConfig;
  let prisma: PrismaClient;
  let fixtures: Fixtures;
  let app: App;

  beforeAll(async () => {
    config = testConfig({ socketRedisAdapter: false });
    prisma = createPrismaClient({ url: config.databaseUrl, poolSize: 2 });
    fixtures = new Fixtures(prisma);
    app = await buildApp({ config, prisma, redis: unreachableRedis(), queues: queuesStub });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await fixtures.cleanup();
    await prisma.$disconnect();
  });

  const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = internal()) =>
    app.inject({ method: 'POST', url: `/internal/auth${url}`, headers, payload });
  function internal(): Record<string, string> {
    return { 'x-internal-api-key': config.internalApiKey, 'x-client-ip': randomIp() };
  }

  function expectServiceUnavailable(res: Awaited<ReturnType<typeof post>>) {
    expect(res.statusCode).toBe(503);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.requestId).toBeTruthy();
    expect(res.headers['retry-after']).toBe(String(STORE_DOWN_RETRY_AFTER_SECONDS));
  }

  it('login, oauth, register, password and email-verification routes answer 503 SERVICE_UNAVAILABLE', async () => {
    const email = testEmail();
    expectServiceUnavailable(await post('/login', { email, password: 'Whatever-123' }));
    expectServiceUnavailable(
      await post('/oauth', {
        provider: 'GOOGLE',
        providerAccountId: `g-${email}`,
        email,
        emailVerified: true,
        name: 'Test',
        locale: 'en',
      }),
    );
    expectServiceUnavailable(
      await post('/register', { name: 'Test User', company: 'Acme', email, password: 'Valid-pass-123', locale: 'en' }),
    );
    expectServiceUnavailable(await post('/password/forgot', { email, locale: 'en' }));
    expectServiceUnavailable(await post('/password/reset', { token: 'x'.repeat(43), password: 'Valid-pass-123' }));
    expectServiceUnavailable(await post('/email/verify', { token: 'x'.repeat(43) }));
    expectServiceUnavailable(await post('/email/resend', { userId: crypto.randomUUID(), locale: 'en' }));
  });

  it('the route handlers never run (no sign-in recorded, no account created)', async () => {
    const { user } = await fixtures.client();
    expectServiceUnavailable(await post('/login', { email: user.email, password: TEST_PASSWORD }));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).toBeNull();

    const email = fixtures.trackEmail(testEmail());
    expectServiceUnavailable(
      await post('/register', { name: 'New User', company: 'Acme', email, password: 'Valid-pass-123', locale: 'en' }),
    );
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('the internal key is still checked first (401 without it)', async () => {
    const res = await post('/login', { email: testEmail(), password: 'x' }, { 'x-client-ip': randomIp() });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('the global limit stays fail-open: Bearer routes and the session-refresh lookup keep working', async () => {
    const { user } = await fixtures.client();
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${await mintToken(config, { sub: user.id })}` },
    });
    expect(me.statusCode).toBe(200); // principal read from the database (cache down)
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);

    const lookup = await app.inject({ method: 'GET', url: `/internal/auth/users/${user.id}`, headers: internal() });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().user).toMatchObject({ id: user.id, sessionVersion: 0 });
  });
});

describe('auth rate limits fail closed when Redis hangs', () => {
  it('a limiter check that never answers → 503 after the timeout', async () => {
    const config = testConfig({ socketRedisAdapter: false });
    const prisma = createPrismaClient({ url: config.databaseUrl, poolSize: 1 });
    const app = await buildApp({ config, prisma, redis: unreachableRedis({ hang: true }), queues: queuesStub });
    try {
      const started = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/internal/auth/login',
        headers: { 'x-internal-api-key': config.internalApiKey, 'x-client-ip': randomIp() },
        payload: { email: testEmail(), password: 'Whatever-123' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
      expect(Date.now() - started).toBeGreaterThanOrEqual(LIMIT_CHECK_TIMEOUT_MS - 50);
      expect(Date.now() - started).toBeLessThan(LIMIT_CHECK_TIMEOUT_MS + 3_000);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});

describe('limitGuard store-error policy', () => {
  it("fails closed by default and open with onStoreError: 'allow'", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { global: false, redis: unreachableRedis() });
    registerErrorHandling(app);
    const rule = { name: 'unit', max: 1, windowMs: 60_000, key: () => 'k' };
    app.get('/closed', { preHandler: limitGuard(app, [rule]) }, async () => ({ ok: true }));
    app.get('/open', { preHandler: limitGuard(app, [rule], { onStoreError: 'allow' }) }, async () => ({ ok: true }));
    try {
      const closed = await app.inject({ method: 'GET', url: '/closed' });
      expect(closed.statusCode).toBe(503);
      expect(closed.json().error.code).toBe('SERVICE_UNAVAILABLE');
      const open = await app.inject({ method: 'GET', url: '/open' });
      expect(open.statusCode).toBe(200);
      expect(open.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
