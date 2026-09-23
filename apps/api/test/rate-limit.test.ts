import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@loons/shared';
import { createTestContext, randomIp, testEmail, type TestContext } from './helpers.ts';

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
});
