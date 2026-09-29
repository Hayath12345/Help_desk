import type { Redis } from 'ioredis';
import type { AppLogger as Logger } from './logger.ts';
import { withTimeout } from './redis.ts';

// Per-user upload budget over a rolling window (default 24 h), counted in the bytes declared at
// presign (the pre-signed POST caps the upload at that size). One sorted set per user,
// `<prefix>upload-quota:<userId>`: member `<attachmentId>|<bytes>`, score = reservation time in
// ms. One Lua script drops entries older than the window, sums the rest and records the new
// reservation only if it fits, so concurrent presigns can never overshoot the budget together.
// The key expires one window after its newest entry.
//
// A reservation counts even when the upload is later rejected or never happens: the pre-signed
// POST lets the caller write that many bytes to storage for 15 minutes, which is what the budget
// bounds. Only a presign that fails on the server (no POST handed out) gives its bytes back.

export const UPLOAD_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A quota check slower than this is treated like an unavailable Redis. */
export const UPLOAD_QUOTA_TIMEOUT_MS = 2_000;

/**
 * KEYS[1] the user's set. ARGV: limit, window (ms), bytes, member, now (ms; '' = Redis TIME, so
 * every API instance uses the same clock). Returns {1, usedAfter, 0} when recorded, or
 * {0, used, retryAfterMs}: the time until the oldest entries whose expiry frees enough budget for
 * `bytes` age out.
 */
const RESERVE_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local bytes = tonumber(ARGV[3])
local now = tonumber(ARGV[5])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local entries = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
-- A member whose size can't be read counts as 0 (reserve() only writes whole positive numbers),
-- so one odd member can't turn every later check into a script error, i.e. into "fail open".
local function size(m) return tonumber(string.match(m, '|(%d+)$')) or 0 end
local used = 0
for i = 1, #entries, 2 do
  used = used + size(entries[i])
end
if used + bytes <= limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, used + bytes, 0}
end
local excess = used + bytes - limit
local freed = 0
for i = 1, #entries, 2 do
  freed = freed + size(entries[i])
  if freed >= excess then
    return {0, used, tonumber(entries[i + 1]) + window - now}
  end
end
return {0, used, window}
`;

export type QuotaDecision =
  { allowed: true } | { allowed: false; limitBytes: number; retryAfterSeconds: number };

export interface UploadQuota {
  readonly limitBytes: number;
  /**
   * Records `bytes` for `attachmentId` if the user's rolling total stays within the limit.
   * Fails open (allowed, nothing recorded) when Redis errors or is slow, like the presign limit.
   * Throws a TypeError, before touching Redis, unless `bytes` is a whole number from 1 to
   * Number.MAX_SAFE_INTEGER: anything else could not be read back by the script.
   */
  reserve(userId: string, attachmentId: string, bytes: number): Promise<QuotaDecision>;
  /** Gives a reservation back (the presign failed before a POST was handed out). */
  release(userId: string, attachmentId: string, bytes: number): Promise<void>;
}

export interface UploadQuotaOptions {
  redis: Redis;
  /** The app's Redis key prefix (`config.redisPrefix`). */
  prefix: string;
  limitBytes: number;
  logger: Logger;
  /** Rolling window (default 24 h); tests shorten it. */
  windowMs?: number;
  /** Clock in ms (default: Redis TIME inside the script); tests pass a fake one. */
  now?: () => number;
}

export function uploadQuotaKey(prefix: string, userId: string): string {
  return `${prefix}upload-quota:${userId}`;
}

export function createUploadQuota(options: UploadQuotaOptions): UploadQuota {
  const { redis, prefix, limitBytes, logger, now } = options;
  const windowMs = options.windowMs ?? UPLOAD_QUOTA_WINDOW_MS;
  const member = (attachmentId: string, bytes: number) => {
    // `1.5`, `-5` or `1e+21` in a member would not match the script's `|(%d+)$`.
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new TypeError(`upload quota: bytes must be a positive safe integer, got ${bytes}`);
    }
    return `${attachmentId}|${bytes}`;
  };

  return {
    limitBytes,

    async reserve(userId, attachmentId, bytes) {
      const entry = member(attachmentId, bytes);
      let reply: unknown;
      try {
        reply = await withTimeout(
          redis.eval(
            RESERVE_SCRIPT,
            1,
            uploadQuotaKey(prefix, userId),
            String(limitBytes),
            String(windowMs),
            String(bytes),
            entry,
            now ? String(Math.floor(now())) : '',
          ),
          UPLOAD_QUOTA_TIMEOUT_MS,
          'upload quota check',
        );
      } catch (err) {
        logger.warn({ err }, 'upload quota unavailable; presign allowed (fail open)');
        return { allowed: true };
      }
      const [ok, , retryAfterMs] = reply as [number, number, number];
      if (ok === 1) return { allowed: true };
      return {
        allowed: false,
        limitBytes,
        retryAfterSeconds: Math.max(1, Math.ceil(Number(retryAfterMs) / 1000)),
      };
    },

    async release(userId, attachmentId, bytes) {
      const entry = member(attachmentId, bytes);
      try {
        await withTimeout(
          redis.zrem(uploadQuotaKey(prefix, userId), entry),
          UPLOAD_QUOTA_TIMEOUT_MS,
          'upload quota release',
        );
      } catch (err) {
        logger.warn({ err }, 'could not give back an upload reservation');
      }
    },
  };
}
