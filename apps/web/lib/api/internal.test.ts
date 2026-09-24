import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAsUser, internalApiFetch } from './internal';

// The incoming request as next/headers would expose it (vi.mock is hoisted above the imports).
const incoming = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => incoming.headers }));

const USER = {
  id: '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f',
  role: 'CLIENT' as const,
  sessionVersion: 0,
};
const INTERNAL_KEY = 'internal-key-for-tests-0123456789-abcdef';

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
);

function sentHeaders(): Headers {
  const init = fetchMock.mock.calls.at(-1)?.[1];
  return new Headers(init?.headers);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('API_INTERNAL_URL', 'http://api.test');
  vi.stubEnv('INTERNAL_API_KEY', INTERNAL_KEY);
  vi.stubEnv('API_JWT_SECRET', 'jwt-secret-for-tests-0123456789-abcdef');
  vi.stubEnv('API_JWT_ISSUER', 'loons-web');
  vi.stubEnv('API_JWT_AUDIENCE', 'loons-api');
  vi.stubEnv('API_TOKEN_TTL_SECONDS', '900');
  vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
  incoming.headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('fetchAsUser (F1: the API limits each end user, not the web server)', () => {
  it('sends the bearer token, the internal key and the end user IP', async () => {
    await fetchAsUser(USER, '/me', { method: 'PATCH', json: { locale: 'ar' } });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://api.test/me');
    const headers = sentHeaders();
    expect(headers.get('authorization')).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(headers.get('x-internal-api-key')).toBe(INTERNAL_KEY);
    expect(headers.get('x-client-ip')).toBe('203.0.113.7');
  });

  it('honours an explicit client IP, or none', async () => {
    await fetchAsUser(USER, '/me', { clientIp: '198.51.100.9' });
    expect(sentHeaders().get('x-client-ip')).toBe('198.51.100.9');
    await fetchAsUser(USER, '/me', { clientIp: null });
    expect(sentHeaders().has('x-client-ip')).toBe(false);
    expect(sentHeaders().get('x-internal-api-key')).toBe(INTERNAL_KEY);
  });

  it('never lets a caller-supplied header smuggle in another client IP', async () => {
    await fetchAsUser(USER, '/me', { clientIp: null, headers: { 'x-client-ip': '1.2.3.4' } });
    expect(sentHeaders().has('x-client-ip')).toBe(false);
  });
});

describe('internalApiFetch', () => {
  it('sends the internal key and the end user IP', async () => {
    await internalApiFetch('/internal/auth/users/abc');
    const headers = sentHeaders();
    expect(headers.get('x-internal-api-key')).toBe(INTERNAL_KEY);
    expect(headers.get('x-client-ip')).toBe('203.0.113.7');
    expect(headers.has('authorization')).toBe(false);
  });

  it('sends no client IP when nothing in front of Next.js vouches for it (TRUSTED_PROXY_HOPS=0)', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
    await internalApiFetch('/internal/auth/login', { method: 'POST', json: {} });
    expect(sentHeaders().has('x-client-ip')).toBe(false);
    await fetchAsUser(USER, '/me');
    expect(sentHeaders().has('x-client-ip')).toBe(false);
  });

  it('fails loudly on an invalid TRUSTED_PROXY_HOPS instead of dropping the IP', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'lots');
    await expect(internalApiFetch('/internal/auth/login')).rejects.toThrow(/TRUSTED_PROXY_HOPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to call the API with a placeholder internal key', async () => {
    vi.stubEnv('INTERNAL_API_KEY', 'replace-me-with-32+-random-bytes');
    await expect(internalApiFetch('/internal/auth/login')).rejects.toThrow(/placeholder/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
