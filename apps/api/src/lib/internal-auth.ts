import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { normalizeIP } from '@fastify/rate-limit';
import { INTERNAL_API_KEY_HEADER } from '@loons/shared';
import { errors } from './errors.ts';

/** Header with the end user's IP, forwarded by the web server on /internal/* calls. */
export const CLIENT_IP_HEADER = 'x-client-ip';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison (hashing first makes both inputs the same length). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export type InternalKeyCheck = 'ok' | 'missing' | 'invalid';

export function checkInternalKey(req: FastifyRequest, expected: string): InternalKeyCheck {
  const provided = headerValue(req, INTERNAL_API_KEY_HEADER);
  if (!provided) return 'missing';
  return safeEqual(provided, expected) ? 'ok' : 'invalid';
}

/**
 * onRequest hook for /internal/*: 401 without the key, 403 with a wrong one. Repeated failures
 * from one address are rate limited by `onFailure` (e.g. 20 per 15 min).
 */
export function internalKeyGuard(
  expected: string,
  onFailure?: (req: FastifyRequest) => Promise<void>,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req) => {
    const result = checkInternalKey(req, expected);
    if (result === 'ok') {
      req.internalCaller = true;
      return;
    }
    if (onFailure) await onFailure(req);
    throw result === 'missing'
      ? errors.unauthenticated('Missing internal API key')
      : errors.forbidden('Invalid internal API key');
  };
}

/** The IP in `x-client-ip`, normalised, or null when absent / not an IP. Trust it only after the key. */
function forwardedClientIp(req: FastifyRequest): string | null {
  const forwarded = headerValue(req, CLIENT_IP_HEADER)?.trim();
  return forwarded && isIP(forwarded) !== 0 ? normalizeIP(forwarded) : null;
}

/**
 * The end user's IP forwarded by the web server in `x-client-ip` (trusted only on requests that
 * already proved the internal key), or null when it sent none — e.g. TRUSTED_PROXY_HOPS=0, where
 * the web server can't know the address. Per-IP limits on /internal/* key on this and are skipped
 * when it is null: falling back to the caller's address would put every end user in the web
 * server's single bucket, so anyone could exhaust a limit for everyone (RR-SEC-2).
 */
export function endUserIp(req: FastifyRequest): string | null {
  return req.internalCaller ? forwardedClientIp(req) : null;
}

/**
 * Key of the global per-IP limit. The web server's own Bearer calls made on a user's behalf
 * (server components, server actions) carry the internal key and the end user's IP in
 * `x-client-ip`, so each end user gets their own bucket instead of all of them sharing the web
 * server's. Without a valid key (browsers, anyone else) the header is ignored.
 */
export function globalRateLimitKey(req: FastifyRequest, internalApiKey: string): string {
  const forwarded = checkInternalKey(req, internalApiKey) === 'ok' ? forwardedClientIp(req) : null;
  return forwarded ?? normalizeIP(req.ip);
}
