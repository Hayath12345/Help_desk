import type { Redis } from 'ioredis';
import { hashKeyPart } from './rate-limit.ts';
import { withTimeout } from './redis.ts';

// Decision D11: at most `SMS_MAX_PER_RECIPIENT_PER_HOUR` texts per phone number per rolling hour
// (a client can choose P1 and page the on-call engineer; this bounds the cost and the noise).
// One sorted set per number, `<redisPrefix>sms-cap:<sha256(number)>` (no phone number in the key
// space), member = the delivery's dedupe key, score = when it was sent (Redis TIME, shared by
// every worker). A retry of the same delivery is not counted twice.
//
// Within that budget, one organisation's P1s may use at most a share of it (`perScopeMax`, default
// a quarter): one client flooding P1s must not use up the on-call engineer's texts and silence a
// real P1 from another customer for the rest of the hour. The share is a second sorted set per
// (number, organisation); a text counts in both.

export const SMS_CAP_WINDOW_MS = 60 * 60_000;
const REDIS_TIMEOUT_MS = 2_000;

/** One organisation's share of a number's hourly budget: a quarter, at least 1. */
export function defaultPerScopeMax(max: number): number {
  return Math.max(1, Math.ceil(max / 4));
}

// KEYS[1] = the number's set, KEYS[2] = the (number, scope) set or "" (no scope).
// ARGV: window ms, max, member, now ms (0 = Redis TIME), scope max.
// Returns 1 (send), 0 (number over the cap) or 2 (scope over its share).
const SCRIPT = `
local now = tonumber(ARGV[4])
if now == 0 then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local window = tonumber(ARGV[1])
local scoped = KEYS[2] ~= ''
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if scoped then redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - window) end
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
if scoped and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 2 end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
if scoped then
  redis.call('ZADD', KEYS[2], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[2], window)
end
return 1
`;

export type SmsCapDecision = 'ok' | 'number-cap' | 'scope-cap';

export interface SmsCap {
  /**
   * Reserves one text to `e164` for `deliveryKey`. False when the number already received
   * `max` texts in the last hour (or `scope` its share). Redis errors fail OPEN (a P1 page matters
   * more than the cap).
   */
  allow(e164: string, deliveryKey: string, scope?: string): Promise<boolean>;
  /** Same, with the reason for a refusal. */
  reserve(e164: string, deliveryKey: string, scope?: string): Promise<SmsCapDecision>;
}

export function createSmsCap(deps: {
  redis: Redis;
  prefix: string;
  max: number;
  /** Texts one scope (organisation) may use of a number's hourly budget (default max / 4). */
  perScopeMax?: number;
  /** Fixed clock for tests (epoch ms); default Redis TIME. */
  now?: () => number;
  windowMs?: number;
  onError?: (err: unknown) => void;
}): SmsCap {
  const windowMs = deps.windowMs ?? SMS_CAP_WINDOW_MS;
  const perScopeMax = deps.perScopeMax ?? defaultPerScopeMax(deps.max);
  async function reserve(
    e164: string,
    deliveryKey: string,
    scope?: string,
  ): Promise<SmsCapDecision> {
    const number = hashKeyPart(e164);
    const key = `${deps.prefix}sms-cap:${number}`;
    const scopeKey = scope ? `${deps.prefix}sms-cap:${number}:${hashKeyPart(scope)}` : '';
    try {
      const result = await withTimeout(
        deps.redis.eval(
          SCRIPT,
          2,
          key,
          scopeKey,
          String(windowMs),
          String(deps.max),
          deliveryKey,
          String(deps.now?.() ?? 0),
          String(perScopeMax),
        ),
        REDIS_TIMEOUT_MS,
        'sms cap',
      );
      const n = Number(result);
      return n === 1 ? 'ok' : n === 2 ? 'scope-cap' : 'number-cap';
    } catch (err) {
      deps.onError?.(err);
      return 'ok';
    }
  }
  return {
    reserve,
    async allow(e164, deliveryKey, scope) {
      return (await reserve(e164, deliveryKey, scope)) === 'ok';
    },
  };
}
