import { Redis, type RedisOptions } from 'ioredis';
import type { AppLogger as Logger } from './logger.ts';

// ioredis 6 speaks RESP3 by default (with v5-compatible "legacy" reply mapping). The test suite
// exercises every Redis consumer on RESP3 against Redis 7 — @fastify/rate-limit (Lua via
// defineCommand), @socket.io/redis-adapter (pub/sub, fetchSockets, cross-node emits) and BullMQ
// (Queue, Worker, QueueEvents) — and all work unchanged. If a managed Redis / proxy without
// HELLO 3 support shows problems, switch this to 2 (ioredis also falls back automatically).
export const REDIS_PROTOCOL: 2 | 3 = 3;

const BASE_OPTIONS: RedisOptions = {
  protocol: REDIS_PROTOCOL,
  connectTimeout: 5_000,
};

/**
 * Connection for request-path work (cache, rate limits, health, queue producers): fails fast
 * instead of queueing commands for a long time while Redis is unreachable.
 */
export function createRedisClient(url: string, logger?: Logger, name = 'app'): Redis {
  const client = new Redis(url, {
    ...BASE_OPTIONS,
    connectionName: `loons-${name}`,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  attachErrorLogging(client, logger, name);
  return client;
}

/** Connection for BullMQ workers (blocking commands require `maxRetriesPerRequest: null`). */
export function createBullConnection(url: string, logger?: Logger, name = 'bullmq'): Redis {
  const client = new Redis(url, {
    ...BASE_OPTIONS,
    connectionName: `loons-${name}`,
    maxRetriesPerRequest: null,
  });
  attachErrorLogging(client, logger, name);
  return client;
}

function attachErrorLogging(client: Redis, logger: Logger | undefined, name: string): void {
  // Without an 'error' listener ioredis prints every reconnect failure as an unhandled error.
  let lastLogged = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLogged < 10_000) return; // one line per 10 s while Redis is down
    lastLogged = now;
    logger?.warn({ err, redis: name }, 'redis connection error');
  });
}

/** Resolves `promise`, or rejects after `ms` (health checks must not hang). */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Closes a connection gracefully, falling back to a hard disconnect. */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  try {
    await withTimeout(client.quit(), 2_000, 'redis quit');
  } catch {
    client.disconnect();
  }
}
