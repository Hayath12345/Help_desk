import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@loons/shared';
import { createTestContext, mintToken, randomIp, testEmail, type TestContext } from './helpers.ts';

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
    for (let i = 0; i < 31; i++) statuses.push((await login(email, `100.64.0.${i + 1}`)).statusCode);
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
      const res = await ctx.app.inject({ method: 'GET', url: '/me', remoteAddress: webServer, headers });
      return Number(res.headers['x-ratelimit-remaining']);
    };
    const key = { 'x-internal-api-key': ctx.config.internalApiKey };
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.11' })).toBe(299);
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.11' })).toBe(298);
    expect(await remaining({ ...key, 'x-client-ip': '192.0.2.12' })).toBe(299);
    // Without the key (browsers) or with a wrong one, x-client-ip is ignored: the connection counts.
    expect(await remaining({ 'x-client-ip': '192.0.2.13' })).toBe(299);
    expect(await remaining({ 'x-internal-api-key': 'wrong', 'x-client-ip': '192.0.2.14' })).toBe(298);
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
