import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@loons/shared';
import { createTestContext, type TestContext } from './helpers.ts';

describe('error responses', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({
      beforeReady: (app) => {
        app.get('/__test/boom', { config: { rateLimit: false } }, async () => {
          throw new Error('database password is hunter2 at /srv/app/secret.ts:42');
        });
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('unknown route → 404 NOT_FOUND in the contract shape with the request id', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/does-not-exist',
      headers: { 'x-request-id': 'trace-abcdef12' },
    });
    expect(res.statusCode).toBe(404);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.requestId).toBe('trace-abcdef12');
    expect(res.headers['x-request-id']).toBe('trace-abcdef12');
  });

  it('zod validation → 400 VALIDATION_FAILED with issue paths and i18n message keys', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/register',
      headers: ctx.internalHeaders(),
      payload: { name: 'A', email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    const details = body.error.details as Array<{
      path: string[];
      message: string;
      location: string;
    }>;
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: 'body',
          path: ['name'],
          message: 'validation.nameMin',
        }),
        expect.objectContaining({ location: 'body', path: ['email'], message: 'validation.email' }),
        expect.objectContaining({
          location: 'body',
          path: ['password'],
          message: 'validation.passwordMin',
        }),
      ]),
    );
  });

  it('malformed JSON → 400 BAD_REQUEST', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: { ...ctx.internalHeaders(), 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expect(res.statusCode).toBe(400);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('BAD_REQUEST');
  });

  it('body over 1 MiB → 413 with the contract shape', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: { ...ctx.internalHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expect(apiErrorSchema.parse(res.json()).error.code).toBe('BAD_REQUEST');
  });

  it('unexpected errors → 500 INTERNAL without leaking the message or stack', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/__test/boom' });
    expect(res.statusCode).toBe(500);
    const body = apiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('INTERNAL');
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('secret.ts');
    expect(body.requestId).toBeTruthy();
  });
});
