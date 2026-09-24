import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errors } from './errors.ts';
import { withTimeout } from './redis.ts';

// Per-route limits beyond the global 300/min/IP. Built on @fastify/rate-limit's
// `createRateLimit` (same Redis store), so several limits can guard one route and the key can
// use data that only exists after validation (e.g. the normalized email in the body).
//
// Store failures: the global limit fails OPEN (plugins/security.ts) so a Redis outage doesn't
// take the API down. Guards built here fail CLOSED by default: the sign-in / sign-up / password
// routes must never run unthrottled, so they answer 503 SERVICE_UNAVAILABLE instead.

export interface LimitRule {
  /** Unique name; becomes part of the Redis key. */
  name: string;
  max: number;
  /** Window in milliseconds. */
  windowMs: number;
  /** Key for this request, or null to skip this rule. */
  key: (req: FastifyRequest) => string | null;
}

/** Emails in Redis keys are hashed (no plain PII in the key space). */
export function hashKeyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** A limiter check slower than this counts as a store failure (a hung Redis must not hold requests). */
export const LIMIT_CHECK_TIMEOUT_MS = 2_000;
/** `Retry-After` sent with 503 SERVICE_UNAVAILABLE while the limiter store is down. */
export const STORE_DOWN_RETRY_AFTER_SECONDS = 30;

export interface LimitGuardOptions {
  /**
   * When the limiter store (Redis) errors or times out:
   * - `'deny'` (default, fail closed): 503 SERVICE_UNAVAILABLE with `Retry-After`.
   * - `'allow'` (fail open): the request goes through unthrottled.
   */
  onStoreError?: 'deny' | 'allow';
}

type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

/**
 * A preHandler enforcing every rule; the first exceeded rule answers 429 RATE_LIMITED with
 * `Retry-After`. Rules are checked in order and each check counts as a hit. See
 * `LimitGuardOptions` for what happens when the store is unavailable (fail closed by default).
 */
export function limitGuard(
  app: FastifyInstance,
  rules: readonly LimitRule[],
  options: LimitGuardOptions = {},
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const failOpen = options.onStoreError === 'allow';
  const limiters: Array<{ rule: LimitRule; check: Limiter }> = rules.map((rule) => ({
    rule,
    check: app.createRateLimit({
      max: rule.max,
      timeWindow: rule.windowMs,
      // Store errors reach the catch below, which applies onStoreError.
      skipOnError: false,
      keyGenerator: (req) => `${rule.name}:${rule.key(req) ?? ''}`,
    }),
  }));

  return async (req, reply) => {
    for (const { rule, check } of limiters) {
      if (rule.key(req) === null) continue;
      let result: Awaited<ReturnType<Limiter>>;
      try {
        result = await withTimeout(check(req), LIMIT_CHECK_TIMEOUT_MS, 'rate limit check');
      } catch (err) {
        if (failOpen) {
          req.log.warn(
            { err, limit: rule.name },
            'rate limit store unavailable; request allowed (fail open)',
          );
          continue;
        }
        req.log.warn(
          { err, limit: rule.name },
          'rate limit store unavailable; request rejected (fail closed)',
        );
        reply.header('retry-after', STORE_DOWN_RETRY_AFTER_SECONDS);
        throw errors.serviceUnavailable(STORE_DOWN_RETRY_AFTER_SECONDS);
      }
      if (!result.isAllowed && result.isExceeded) {
        const retryAfter = Math.max(1, result.ttlInSeconds);
        reply.header('retry-after', retryAfter);
        req.log.warn({ limit: rule.name }, 'rate limit exceeded');
        throw errors.rateLimited(retryAfter);
      }
    }
  };
}
