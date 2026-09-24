import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '@loons/db';
import { buildApp } from '../src/app.ts';
import type { AppQueues } from '../src/lib/queues.ts';
import { createTestContext, testConfig, type TestContext } from './helpers.ts';

describe('health', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('GET /health reports ok when Postgres and Redis are reachable', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok' },
      version: expect.any(String),
    });
  });

  it('GET /health/live answers without dependency checks', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('echoes a safe incoming x-request-id and replaces an unsafe one', async () => {
    const good = await ctx.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(good.headers['x-request-id']).toBe('req-12345678');

    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'bad id\n{"injected":true}' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers (helmet)', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('allows configured CORS origins only', async () => {
    const origin = ctx.config.corsOrigins[0] ?? 'http://localhost:3000';
    const ok = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/me',
      headers: {
        origin,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(origin);
    expect(String(ok.headers['access-control-allow-methods'])).toContain('PATCH');

    const evil = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document with both security schemes', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['bearerAuth', 'internalApiKey']);
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/me',
        '/internal/auth/login',
        '/internal/auth/password/reset',
      ]),
    );
  });
});

describe('health with Redis down (stub)', () => {
  it('returns 503 and marks redis as down', async () => {
    const config = testConfig({ socketRedisAdapter: false });
    const prisma = createPrismaClient({ url: config.databaseUrl, poolSize: 1 });
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    const redisStub = {
      ping: down,
      get: down,
      set: down,
      del: down,
      defineCommand: () => undefined,
      // @fastify/rate-limit store command (callback style) — fails; skipOnError lets requests through.
      rateLimit: (...args: unknown[]) =>
        (args.at(-1) as (err: Error) => void)(new Error('ECONNREFUSED')),
      rateLimitRead: (...args: unknown[]) =>
        (args.at(-1) as (err: Error) => void)(new Error('ECONNREFUSED')),
    } as unknown as Redis;
    const queuesStub = { close: async () => undefined } as unknown as AppQueues;

    const app = await buildApp({ config, prisma, redis: redisStub, queues: queuesStub });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'error', checks: { db: 'ok', redis: 'down' } });

      // Liveness does not depend on Redis.
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      expect(live.statusCode).toBe(200);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
