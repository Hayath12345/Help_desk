import { apiTokenClaimsSchema } from '@loons/shared';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintApiToken } from './token';

const SECRET = 'test-secret-that-is-long-enough-0123456789';
const USER = {
  id: '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f',
  role: 'AGENT' as const,
  sessionVersion: 3,
};
const key = new TextEncoder().encode(SECRET);

beforeEach(() => {
  vi.stubEnv('API_JWT_SECRET', SECRET);
  vi.stubEnv('API_JWT_ISSUER', 'loons-web');
  vi.stubEnv('API_JWT_AUDIENCE', 'loons-api');
  vi.stubEnv('API_TOKEN_TTL_SECONDS', '900');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('mintApiToken', () => {
  it('signs an HS256 token the API can verify with the shared secret, issuer and audience', async () => {
    const { token } = await mintApiToken(USER);
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: 'loons-web',
      audience: 'loons-api',
    });
    expect(protectedHeader).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload.sub).toBe(USER.id);
    expect(payload.role).toBe('AGENT');
    expect(payload.sv).toBe(3);
    expect(typeof payload.jti).toBe('string');
    // Matches the claims contract in @loons/shared.
    expect(apiTokenClaimsSchema.safeParse(payload).success).toBe(true);
  });

  it('carries the session version as `sv` (the API rejects the token once it changes)', async () => {
    const first = await mintApiToken({ ...USER, sessionVersion: 0 });
    expect((await jwtVerify(first.token, key)).payload.sv).toBe(0);
    const later = await mintApiToken({ ...USER, sessionVersion: 7 });
    const { payload } = await jwtVerify(later.token, key);
    expect(payload.sv).toBe(7);
    expect(apiTokenClaimsSchema.parse(payload).sv).toBe(7);
  });

  it('expires after API_TOKEN_TTL_SECONDS and reports expiresAt in epoch ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    const { token, expiresAt } = await mintApiToken(USER);
    const { payload } = await jwtVerify(token, key, {
      currentDate: new Date('2026-09-23T10:00:00Z'),
    });
    const iat = Date.parse('2026-09-23T10:00:00Z') / 1000;
    expect(payload.iat).toBe(iat);
    expect(payload.exp).toBe(iat + 900);
    expect(expiresAt).toBe((iat + 900) * 1000);

    await expect(
      jwtVerify(token, key, { currentDate: new Date('2026-09-23T10:15:01Z') }),
    ).rejects.toThrow();
  });

  it('uses a unique jti per token', async () => {
    const a = await mintApiToken(USER);
    const b = await mintApiToken(USER);
    const ja = (await jwtVerify(a.token, key)).payload.jti;
    const jb = (await jwtVerify(b.token, key)).payload.jti;
    expect(ja).not.toBe(jb);
  });

  it('is rejected when verified with another secret or audience', async () => {
    const { token } = await mintApiToken(USER);
    await expect(jwtVerify(token, new TextEncoder().encode('x'.repeat(40)))).rejects.toThrow();
    await expect(jwtVerify(token, key, { audience: 'someone-else' })).rejects.toThrow();
    expect(decodeProtectedHeader(token).alg).toBe('HS256');
  });

  it('falls back to 900 s for an out-of-range TTL', async () => {
    vi.stubEnv('API_TOKEN_TTL_SECONDS', '999999');
    const { token } = await mintApiToken(USER);
    const { payload } = await jwtVerify(token, key);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
  });

  it('refuses to sign without a (long enough) secret', async () => {
    vi.stubEnv('API_JWT_SECRET', '');
    await expect(mintApiToken(USER)).rejects.toThrow(/API_JWT_SECRET/);
    vi.stubEnv('API_JWT_SECRET', 'short');
    await expect(mintApiToken(USER)).rejects.toThrow(/at least/);
  });
});
