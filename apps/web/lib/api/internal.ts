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

type ServerCallOptions = {
  /**
   * End-user IP forwarded as `x-client-ip`. Defaults to the incoming request's
   * `x-forwarded-for` / `x-real-ip` (per TRUSTED_PROXY_HOPS); pass `null` to send none.
   */
  clientIp?: string | null;
};

export type ApiFetchInit = JsonRequestInit &
  ServerCallOptions & {
    /** Act as this user (defaults to the current session user). */
    user?: CurrentUser;
  };

export type InternalApiFetchInit = JsonRequestInit & ServerCallOptions;

/**
 * The incoming request's client IP, or null when it is unknown: outside a request scope (e.g. in
 * proxy callbacks) or with TRUSTED_PROXY_HOPS=0 (no proxy vouches for X-Forwarded-For).
 */
async function incomingClientIp(): Promise<string | null> {
  // Outside the try: a misconfigured TRUSTED_PROXY_HOPS must fail loudly, not look like "no IP".
  const hops = trustedProxyHops();
  if (hops === 0) return null;
  try {
    return clientIpFromHeaders(await headers(), hops);
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

function withDefaultTimeout<T extends JsonRequestInit>(init: T): T {
  return init.signal ? init : { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
}

/**
 * Headers every server → API call carries: the internal key (proves the call comes from the web
 * server, so the API may trust `x-client-ip`) and the end user's IP. The API keys its rate limits
 * on that IP instead of the web server's own address.
 */
async function serverHeaders(
  base: HeadersInit | undefined,
  clientIp: string | null | undefined,
): Promise<Headers> {
  const requestHeaders = new Headers(base);
  requestHeaders.set(INTERNAL_API_KEY_HEADER, internalApiKey());
  const ip = clientIp === undefined ? await incomingClientIp() : clientIp;
  if (ip) requestHeaders.set(CLIENT_IP_HEADER, ip);
  else requestHeaders.delete(CLIENT_IP_HEADER);
  return requestHeaders;
}

/** Server-to-server call to /internal/* (adds x-internal-api-key and x-client-ip). */
export async function internalApiFetch<T>(
  path: string,
  init: InternalApiFetchInit = {},
): Promise<T> {
  const { clientIp, ...rest } = init;
  const requestHeaders = await serverHeaders(rest.headers, clientIp);
  return requestJson<T>(
    joinUrl(apiInternalUrl(), path),
    withDefaultTimeout({ ...rest, headers: requestHeaders }),
  );
}

/**
 * Authenticated call to the API as `user` (mints a fresh bearer token). Like internalApiFetch it
 * also sends x-internal-api-key and x-client-ip, so the API's global per-IP limit counts each end
 * user separately instead of the web server as one client. Never used from the browser.
 */
export async function fetchAsUser<T>(
  user: Pick<CurrentUser, 'id' | 'role' | 'sessionVersion'>,
  path: string,
  init: JsonRequestInit & ServerCallOptions = {},
): Promise<T> {
  const { clientIp, ...rest } = init;
  const { token } = await mintApiToken(user);
  const requestHeaders = await serverHeaders(rest.headers, clientIp);
  requestHeaders.set('authorization', `Bearer ${token}`);
  return requestJson<T>(
    joinUrl(apiInternalUrl(), path),
    withDefaultTimeout({ ...rest, headers: requestHeaders }),
  );
}
