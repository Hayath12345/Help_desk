import { randomBytes } from 'node:crypto';
import { closeRedis, createRedisClient } from '../src/lib/redis.ts';

// One id per `vitest run`: every test context's Redis prefix starts with `loons-test:<run>:`
// (helpers.ts `testRedisPrefix`). A context normally deletes its own keys in `close()`; when a
// worker process dies before that (review F8: a Windows worker abort left BullMQ meta keys
// behind), the run's teardown here removes whatever is left — and only this run's keys, so
// parallel runs never touch each other.

export const TEST_RUN_ENV = 'LOONS_TEST_RUN';

export default function setup(): () => Promise<void> {
  const runId = randomBytes(4).toString('hex');
  // Forked workers inherit the environment of the main process.
  process.env[TEST_RUN_ENV] = runId;
  return async function teardown() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    const redis = createRedisClient(url, undefined, 'test-teardown');
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `loons-test:${runId}:*`,
          'COUNT',
          500,
        );
        cursor = next;
        if (keys.length) await redis.del(...keys);
      } while (cursor !== '0');
    } finally {
      await closeRedis(redis);
    }
  };
}
