import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, randomIp, type TestContext } from './helpers.ts';

describe('internal API key', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('401 UNAUTHENTICATED without the key', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/internal/auth/users/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('403 FORBIDDEN with a wrong key (same length or not)', async () => {
    for (const key of ['nope', 'x'.repeat(ctx.config.internalApiKey.length)]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/internal/auth/users/${randomUUID()}`,
        headers: { 'x-internal-api-key': key },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('passes with the key (unknown user → 404 NOT_FOUND)', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/internal/auth/users/${randomUUID()}`,
      headers: ctx.internalHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /internal/auth/users/:id returns the user (including disabled ones)', async () => {
    const { user, org } = await ctx.fixtures.client({ status: 'DISABLED' });
    const team = await ctx.fixtures.team();
    await ctx.fixtures.member(team.id, user.id);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/internal/auth/users/${user.id}`,
      headers: ctx.internalHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'CLIENT',
      status: 'DISABLED',
      orgId: org.id,
      locale: 'en',
      teamIds: [team.id],
      sessionVersion: 0,
      emailVerified: true,
    });
  });

  it('rejects a malformed user id with 400', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/internal/auth/users/not-a-uuid',
      headers: ctx.internalHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rate-limits repeated wrong keys from one address (429 after 20)', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/internal/auth/users/${randomUUID()}`,
        headers: { 'x-internal-api-key': 'wrong' },
        remoteAddress: ip,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(statuses[20]).toBe(429);

    // The web server (valid key) from the same address is unaffected.
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/internal/auth/users/${randomUUID()}`,
      headers: ctx.internalHeaders(),
      remoteAddress: ip,
    });
    expect(ok.statusCode).toBe(404);
  });
});
