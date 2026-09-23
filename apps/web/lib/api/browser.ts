// Browser-side API client for Client Components (TanStack Query fetchers, socket auth, …).
// The access token comes from the Next route GET /api/token and is cached in memory until
// 60 s before it expires. A 401 from the API drops the cache and retries once with a new token.
import { ApiRequestError, toApiRequestError } from './errors';
import { joinUrl, requestJson, type JsonRequestInit } from './http';

const TOKEN_ENDPOINT = '/api/token';
/** Refresh the cached token this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;
/** Bumped by clearApiToken() so a request started before a sign-out cannot repopulate the cache. */
let generation = 0;

function apiBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) throw new Error('NEXT_PUBLIC_API_URL is not set');
  return url;
}

function isFresh(token: CachedToken | null): token is CachedToken {
  return token !== null && Date.now() < token.expiresAt - EXPIRY_MARGIN_MS;
}

async function requestToken(): Promise<CachedToken> {
  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    throw new ApiRequestError(
      0,
      'INTERNAL',
      'Could not reach the web server',
      undefined,
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!response.ok) throw await toApiRequestError(response);
  const body = (await response.json()) as Partial<CachedToken>;
  if (typeof body.token !== 'string' || typeof body.expiresAt !== 'number') {
    throw new ApiRequestError(response.status, 'INTERNAL', 'Malformed token response');
  }
  return { token: body.token, expiresAt: body.expiresAt };
}

/** Returns a valid access token, fetching a new one when missing, near expiry or forced. */
export async function getApiToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
  if (!options.forceRefresh && isFresh(cached)) return cached.token;
  if (!inflight) {
    const startedAt = generation;
    inflight = requestToken()
      .then((token) => {
        if (startedAt === generation) cached = token;
        return token;
      })
      .finally(() => {
        if (startedAt === generation) inflight = null;
      });
  }
  return (await inflight).token;
}

/** Forget the cached token (call on sign-in / sign-out so another user never reuses it). */
export function clearApiToken(): void {
  cached = null;
  inflight = null;
  generation += 1;
}

export type ApiClientInit = JsonRequestInit;

/** Calls the API as the signed-in user. Throws `ApiRequestError` on failure. */
export async function apiRequest<T>(path: string, init: ApiClientInit = {}): Promise<T> {
  const url = joinUrl(apiBaseUrl(), path);
  const attempt = async (forceRefresh: boolean): Promise<T> => {
    const token = await getApiToken({ forceRefresh });
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return requestJson<T>(url, { ...init, headers, credentials: 'omit' });
  };

  try {
    return await attempt(false);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      // The API rejected the token (expired early, secret rotated, user reloaded…): retry once.
      cached = null;
      return attempt(true);
    }
    throw error;
  }
}

type BodylessInit = Omit<ApiClientInit, 'method' | 'json' | 'body'>;

export const apiClient = {
  request: apiRequest,
  get: <T>(path: string, init?: BodylessInit) => apiRequest<T>(path, { ...init, method: 'GET' }),
  delete: <T>(path: string, init?: BodylessInit) =>
    apiRequest<T>(path, { ...init, method: 'DELETE' }),
  post: <T>(path: string, json?: unknown, init?: BodylessInit) =>
    apiRequest<T>(path, { ...init, method: 'POST', json }),
  put: <T>(path: string, json?: unknown, init?: BodylessInit) =>
    apiRequest<T>(path, { ...init, method: 'PUT', json }),
  patch: <T>(path: string, json?: unknown, init?: BodylessInit) =>
    apiRequest<T>(path, { ...init, method: 'PATCH', json }),
};

export { ApiRequestError } from './errors';
