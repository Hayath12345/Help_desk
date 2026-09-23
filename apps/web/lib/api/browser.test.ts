import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, clearApiToken, getApiToken } from './browser';
import { ApiRequestError } from './errors';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

let tokenCounter = 0;
let now = 1_800_000_000_000;

function tokenResponse(ttlMs = 15 * 60_000) {
  tokenCounter += 1;
  return Response.json({ token: `t${tokenCounter}`, expiresAt: now + ttlMs });
}

function installFetch(handler: Handler) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const authOf = (init?: RequestInit) => new Headers(init?.headers).get('authorization');

beforeEach(() => {
  tokenCounter = 0;
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://api.test');
  clearApiToken();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getApiToken', () => {
  it('caches the token until 60 s before expiry', async () => {
    const fetchMock = installFetch(() => tokenResponse());
    await expect(getApiToken()).resolves.toBe('t1');
    now += 13 * 60_000;
    await expect(getApiToken()).resolves.toBe('t1');
    now += 60_000 + 1; // within the last minute → refresh
    await expect(getApiToken()).resolves.toBe('t2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/token');
    expect(fetchMock.mock.calls[0]![1]?.cache).toBe('no-store');
  });

  it('shares one request between concurrent callers', async () => {
    const fetchMock = installFetch(() => tokenResponse());
    const tokens = await Promise.all([getApiToken(), getApiToken(), getApiToken()]);
    expect(tokens).toEqual(['t1', 't1', 't1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws UNAUTHENTICATED when signed out', async () => {
    installFetch(() =>
      Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Not signed in' } },
        { status: 401 },
      ),
    );
    await expect(getApiToken()).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });

  it('forgets the token on clearApiToken()', async () => {
    const fetchMock = installFetch(() => tokenResponse());
    await getApiToken();
    clearApiToken();
    await expect(getApiToken()).resolves.toBe('t2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('apiClient', () => {
  it('calls NEXT_PUBLIC_API_URL with the bearer token', async () => {
    const fetchMock = installFetch((url) =>
      url === '/api/token' ? tokenResponse() : Response.json({ user: { id: 'u1' } }),
    );
    await expect(apiClient.get('/me')).resolves.toEqual({ user: { id: 'u1' } });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://api.test/me');
    expect(authOf(init)).toBe('Bearer t1');
    expect(init?.method).toBe('GET');
  });

  it('retries once with a fresh token after a 401', async () => {
    const seen: (string | null)[] = [];
    installFetch((url, init) => {
      if (url === '/api/token') return tokenResponse();
      seen.push(authOf(init));
      return seen.length === 1
        ? Response.json({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }, { status: 401 })
        : new Response(null, { status: 204 });
    });
    await expect(apiClient.patch('/me', { locale: 'ar' })).resolves.toBeUndefined();
    expect(seen).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('gives up after the retry also fails', async () => {
    const fetchMock = installFetch((url) =>
      url === '/api/token'
        ? tokenResponse()
        : Response.json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, { status: 401 }),
    );
    const error = await apiClient.get('/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // token, call, token, call
  });

  it('does not retry other errors', async () => {
    const fetchMock = installFetch((url) =>
      url === '/api/token'
        ? tokenResponse()
        : Response.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 }),
    );
    await expect(apiClient.post('/tickets', { a: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
