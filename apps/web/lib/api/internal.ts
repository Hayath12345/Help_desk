// Low-level server-side API access. Kept free of session imports so `auth.ts` can use it
// without an import cycle (auth.ts → here; lib/session.ts → auth.ts; lib/api/server.ts → both).
import 'server-only';
import { INTERNAL_API_KEY_HEADER } from '@loons/shared';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { apiInternalUrl, internalApiKey, trustedProxyHops } from '@/lib/auth/env';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import type { CurrentUser } from '@/lib/session';
import { joinUrl, requestJson, type JsonRequestInit } from './http';
import { mintApiToken } from './token';

export const CLIENT_IP_HEADER = 'x-client-ip';

/** Server-side API calls give up after this long unless the caller passes its own signal. */
const DEFAULT_TIMEOUT_MS = 15_000;

export type ApiFetchInit = JsonRequestInit & {
  /** Act as this user (defaults to the current session user). */
  user?: CurrentUser;
};

export type InternalApiFetchInit = JsonRequestInit & {
  /**
   * End-user IP forwarded as `x-client-ip`. Defaults to the incoming request's
   * `x-forwarded-for` / `x-real-ip`; pass `null` to send none.
   */
  clientIp?: string | null;
};

/** The incoming request's client IP, or null outside a request scope (e.g. in proxy callbacks). */
async function incomingClientIp(): Promise<string | null> {
  try {
    return clientIpFromHeaders(await headers(), trustedProxyHops());
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

function withDefaultTimeout<T extends JsonRequestInit>(init: T): T {
  return init.signal ? init : { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
}

/** Server-to-server call to /internal/* (adds x-internal-api-key and x-client-ip). */
export async function internalApiFetch<T>(
  path: string,
  init: InternalApiFetchInit = {},
): Promise<T> {
  const { clientIp, ...rest } = init;
  const requestHeaders = new Headers(rest.headers);
  requestHeaders.set(INTERNAL_API_KEY_HEADER, internalApiKey());
  const ip = clientIp === undefined ? await incomingClientIp() : clientIp;
  if (ip) requestHeaders.set(CLIENT_IP_HEADER, ip);
  return requestJson<T>(
    joinUrl(apiInternalUrl(), path),
    withDefaultTimeout({ ...rest, headers: requestHeaders }),
  );
}

/** Authenticated call to the API as `user` (mints a fresh bearer token). */
export async function fetchAsUser<T>(
  user: Pick<CurrentUser, 'id' | 'role' | 'sessionVersion'>,
  path: string,
  init: JsonRequestInit = {},
): Promise<T> {
  const { token } = await mintApiToken(user);
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set('authorization', `Bearer ${token}`);
  return requestJson<T>(
    joinUrl(apiInternalUrl(), path),
    withDefaultTimeout({ ...init, headers: requestHeaders }),
  );
}
