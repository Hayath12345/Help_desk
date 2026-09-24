import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@loons/shared';
import { HOUR, MINUTE } from '../src/lib/rate-limit.ts';
import { GLOBAL_AUTH_LIMITS } from '../src/routes/internal/auth.ts';
import {
  TEST_PASSWORD,
  createTestContext,
  mintToken,
  randomIp,
  testEmail,
  type TestContext,
} from './helpers.ts';

describe('rate limits', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const login = (email: string, clientIp: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: ctx.internalHeaders(clientIp),
      payload: { email, password: 'Wrong-password-1' },
    });

  it('login: 10 attempts per (client IP, email) per 15 min, then 429 RATE_LIMITED', async () => {
    const ip = randomIp();
    const email = testEmail();
    for (let i = 0; i < 10; i++) {
      expect((await login(email, ip)).statusCode).toBe(401);
    }
    const limited = await login(email, ip);
    expect(limited.statusCode).toBe(429);
    const body = apiErrorSchema.parse(limited.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // Keyed on x-client-ip from the web server, not the connection address:
    // another end user (different x-client-ip) is unaffected…
    expect((await login(email, randomIp())).statusCode).toBe(401);
    // …and so is the same end user with another email.
    expect((await login(testEmail(), ip)).statusCode).toBe(401);
  });

  it('login: 50 attempts per client IP per 15 min across emails', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 51; i++) statuses.push((await login(testEmail(), ip)).statusCode);
    expect(statuses.slice(0, 50).every((s) => s === 401)).toBe(true);
    expect(statuses[50]).toBe(429);
  });

  it('login: 30 attempts per email per hour, whatever the client IP', async () => {
    const email = testEmail();
    const statuses: number[] = [];
    // Addresses no other test here uses (their per-IP limits must not interfere).
    for (let i = 0; i < 31; i++)
      statuses.push((await login(email, `100.64.0.${i + 1}`)).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Other accounts are unaffected.
    expect((await login(testEmail(), '100.64.0.1')).statusCode).toBe(401);
  });

  it('forgot password: 5 per email per hour, whatever the client IP', async () => {
    const email = testEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/internal/auth/password/forgot',
        headers: ctx.internalHeaders(`100.64.1.${i + 1}`),
        payload: { email },
      });
      statuses.push(res.statusCode);
    }
    await ctx.app.background.drain();
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('forgot password: 5 per (client IP, email) per 15 min', async () => {
    const ip = randomIp();
    const email = testEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/internal/auth/password/forgot',
        headers: ctx.internalHeaders(ip),
        payload: { email },
      });
      statuses.push(res.statusCode);
    }
    await ctx.app.background.drain();
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('global limit: 300 requests per minute per IP on public routes', async () => {
    const ip = randomIp();
    let last = 0;
    for (let i = 0; i < 301; i++) {
      const res = await ctx.app.inject({ method: 'GET', url: '/me', remoteAddress: ip });
      last = res.statusCode;
      if (i < 300) expect(res.statusCode).toBe(401);
    }
    expect(last).toBe(429);
    // Health probes are exempt.
    const health = await ctx.app.inject({ method: 'GET', url: '/health/live', remoteAddress: ip });
    expect(health.statusCode).toBe(200);
  });

  it('global limit: the web server’s Bearer calls count per end user (x-client-ip + internal key)', async () => {
    const webServer = '192.0.2.200';
    const remaining = async (headers: Record<string, string>) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/me',
        remoteAddress: webServer,
        headers,
      });
      return Number(res.headers['x-ratelimit-remaining']);
    };
    const key = { 'x-internal-api-key': ctx.config.internalApiKey };
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.11' })).toBe(299);
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.11' })).toBe(298);
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.12' })).toBe(299);
    // Without the key (browsers) or with a wrong one, x-client-ip is ignored: the connection counts.
    expect(await remaining({ 'x-client-ip': '192.0.2.13' })).toBe(299);
    expect(await remaining({ 'x-internal-api-key': 'wrong', 'x-client-ip': '192.0.2.14' })).toBe(
      298,
    );
    // The key without a usable x-client-ip also falls back to the connection address.
    expect(await remaining(key)).toBe(297);
    expect(await remaining({ ...key, 'x-client-ip': 'not-an-ip' })).toBe(296);
  });

  it('global limit: one user’s 300 server-side calls don’t lock out other users of the same web server', async () => {
    const webServer = '192.0.2.201';
    const { user: a } = await ctx.fixtures.client();
    const { user: b } = await ctx.fixtures.client();
    const call = async (userId: string, clientIp: string) =>
      ctx.app.inject({
        method: 'GET',
        url: '/me',
        remoteAddress: webServer,
        headers: {
          authorization: `Bearer ${await mintToken(ctx.config, { sub: userId })}`,
          'x-internal-api-key': ctx.config.internalApiKey,
          'x-client-ip': clientIp,
        },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 301; i++) statuses.push((await call(a.id, '192.0.2.21')).statusCode);
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
    expect(statuses[300]).toBe(429);
    expect((await call(b.id, '192.0.2.22')).statusCode).toBe(200);
  });
});

describe('TRUST_PROXY hop count (one load balancer in front of the API)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({
      config: { trustProxy: 1 },
      beforeReady: (app) => {
        app.get('/__test/ip', { config: { rateLimit: false } }, async (req) => ({ ip: req.ip }));
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const loadBalancer = '10.0.0.5';
  const ipOf = async (xff?: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/__test/ip',
      remoteAddress: loadBalancer,
      headers: xff ? { 'x-forwarded-for': xff } : {},
    });
    return res.json().ip;
  };

  it('request.ip is the address the load balancer appended, not one the client sent', async () => {
    expect(await ipOf('192.0.2.50')).toBe('192.0.2.50');
    expect(await ipOf('198.51.100.1, 198.51.100.2, 192.0.2.50')).toBe('192.0.2.50');
    expect(await ipOf()).toBe(loadBalancer);
  });

  it('rotating a spoofed X-Forwarded-For does not escape the global limit', async () => {
    const remaining: number[] = [];
    for (const spoofed of ['198.51.100.7', '198.51.100.8', '198.51.100.9']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/me',
        remoteAddress: loadBalancer,
        headers: { 'x-forwarded-for': `${spoofed}, 192.0.2.60` },
      });
      remaining.push(Number(res.headers['x-ratelimit-remaining']));
    }
    expect(remaining).toEqual([299, 298, 297]);
  });
});

describe('internal calls without x-client-ip (web TRUSTED_PROXY_HOPS=0): per-IP rules are skipped, never pooled (RR-SEC-2)', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const webServer = '192.0.2.250';
  /** The internal key but no x-client-ip, always from the web server's one address. */
  const post = (url: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/internal/auth${url}`,
      remoteAddress: webServer,
      headers: { 'x-internal-api-key': ctx.config.internalApiKey },
      payload,
    });
  const limitKeys = (rule: string) => ctx.redis.keys(`${ctx.config.redisPrefix}rl:*${rule}:*`);

  it('login: many users behind one web server are not one bucket; the per-email limit still holds', async () => {
    // 60 wrong passwords over many emails: a shared login:ip bucket (50) would have tripped.
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      statuses.push(
        (await post('/login', { email: testEmail(), password: 'Wrong-password-1' })).statusCode,
      );
    }
    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(await limitKeys('login:ip')).toEqual([]);

    // One email: login:ip-email (10) is skipped too, but login:email (30 per hour) holds.
    const email = testEmail();
    const same: number[] = [];
    for (let i = 0; i < 31; i++)
      same.push((await post('/login', { email, password: 'Wrong-password-1' })).statusCode);
    expect(same.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(same[30]).toBe(429);
  });

  it('forgot password: the per-email limit still holds', async () => {
    const email = testEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await post('/password/forgot', { email })).statusCode);
    await ctx.app.background.drain();
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    expect((await post('/password/forgot', { email: testEmail() })).statusCode).toBe(202);
    await ctx.app.background.drain();
  });

  it('register and verify: the per-IP limits do not pool everyone; the unknown-IP caps count instead', async () => {
    const registered: number[] = [];
    for (let i = 0; i < 6; i++) {
      const email = ctx.fixtures.trackEmail(testEmail());
      registered.push(
        (await post('/register', { name: 'No Ip', email, password: TEST_PASSWORD })).statusCode,
      );
    }
    expect(registered).toEqual([201, 201, 201, 201, 201, 201]); // register:ip is 5 per hour
    const verified: number[] = [];
    for (let i = 0; i < 11; i++) {
      verified.push(
        (
          await post('/email/verify', {
            token: `guess-${i}`.padEnd(43, 'g'),
            userId: crypto.randomUUID(),
          })
        ).statusCode,
      );
    }
    expect(new Set(verified)).toEqual(new Set([400])); // verify:ip is 10 per 15 min
    expect((await post('/email/link', { token: 'peek'.padEnd(43, 'p') })).statusCode).toBe(400);

    expect(await limitKeys('register:ip')).toEqual([]);
    expect(await limitKeys('verify:ip')).toEqual([]);
    for (const rule of ['register:no-ip', 'verify:no-ip', 'link:no-ip']) {
      expect(await limitKeys(rule), rule).toHaveLength(1);
    }
    expect(GLOBAL_AUTH_LIMITS).toEqual({
      register: { max: 100, windowMs: HOUR },
      link: { max: 600, windowMs: 15 * MINUTE },
      verify: { max: 300, windowMs: 15 * MINUTE },
      resend: { max: 100, windowMs: 15 * MINUTE },
    });
  });

  it('resend: the unknown-IP cap holds without an IP, and never limits callers with a known IP', async () => {
    const { max } = GLOBAL_AUTH_LIMITS.resend;
    const statuses: number[] = [];
    // A different user each time, so resend:user never trips.
    for (let i = 0; i <= max; i++) {
      statuses.push((await post('/email/resend', { userId: crypto.randomUUID() })).statusCode);
    }
    expect(statuses.slice(0, max).every((s) => s === 202)).toBe(true);
    expect(statuses[max]).toBe(429);

    // Filling the unknown-IP bucket doesn't lock out end users whose IP is known.
    const withIp = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/email/resend',
      headers: ctx.internalHeaders(randomIp()),
      payload: { userId: crypto.randomUUID() },
    });
    expect(withIp.statusCode).toBe(202);
    await ctx.app.background.drain();
  });

  it('callers with a known IP never touch the unknown-IP caps (no shared bucket to fill)', async () => {
    const keys = await limitKeys('link:no-ip');
    const read = () => Promise.all(keys.map((key) => ctx.redis.get(key)));
    const before = await read();
    for (let i = 0; i < 3; i++) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/internal/auth/email/link',
        headers: ctx.internalHeaders(randomIp()),
        payload: { token: `known-ip-${i}`.padEnd(43, 'k') },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await limitKeys('link:no-ip')).toEqual(keys);
    expect(await read()).toEqual(before);
  });
});
