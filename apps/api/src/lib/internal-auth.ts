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

/**
 * The end user's IP for rate limiting. `x-client-ip` is trusted only on requests that already
 * proved the internal key; everything else uses the socket / proxy address.
 */
export function clientIp(req: FastifyRequest): string {
  if (req.internalCaller) {
    const forwarded = headerValue(req, CLIENT_IP_HEADER)?.trim();
    if (forwarded && isIP(forwarded) !== 0) return normalizeIP(forwarded);
  }
  return normalizeIP(req.ip);
}
