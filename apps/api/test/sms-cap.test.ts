import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTicketJobs } from '../src/lib/job-cleanup.ts';
import { escalationJobId } from '../src/lib/job-data.ts';
import { createQueues, type AppQueues } from '../src/lib/queues.ts';
import { closeRedis, createRedisClient } from '../src/lib/redis.ts';
import { SMS_CAP_WINDOW_MS, createSmsCap, defaultPerScopeMax } from '../src/lib/sms-cap.ts';
import { testConfig } from './helpers.ts';
import { allJobs, testPhone } from './worker-helpers.ts';

// Redis-backed pieces of Phase 3 without the app: the per-number SMS cap (D11) and the removal
// of a deleted ticket's queued jobs (e2e teardown).

describe('Redis helpers', () => {
  const config = testConfig();
  const redis = createRedisClient(config.redisUrl);
  let queues: AppQueues;

  beforeAll(() => {
    queues = createQueues({ connection: redis, prefix: `${config.redisPrefix}bull` });
  });
  afterAll(async () => {
    await Promise.allSettled(
      [queues.notifications, queues.escalation, queues.sla, queues.email].map((q) =>
        q.obliterate({ force: true }),
      ),
    );
    await queues.close();
    const keys = await redis.keys(`${config.redisPrefix}*`);
    if (keys.length) await redis.del(...keys);
    await closeRedis(redis);
  });

  describe('SMS cap (D11)', () => {
    it('allows N texts per number per rolling hour; a retried delivery counts once; numbers are separate', async () => {
      let now = 1_000_000;
      const cap = createSmsCap({ redis, prefix: config.redisPrefix, max: 3, now: () => now });
      const phone = testPhone();
      const other = testPhone();
      const results = [];
      for (const key of ['a', 'b', 'c', 'd']) results.push(await cap.allow(phone, key));
      expect(results).toEqual([true, true, true, false]);
      // The same delivery again (a retry): still allowed, not counted twice.
      expect(await cap.allow(phone, 'a')).toBe(true);
      expect(await cap.allow(other, 'a')).toBe(true);
      // An hour after the first text, room again.
      now += SMS_CAP_WINDOW_MS + 1;
      expect(await cap.allow(phone, 'e')).toBe(true);
      // No phone number in the key space.
      const keys = await redis.keys(`${config.redisPrefix}sms-cap:*`);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join(' ')).not.toContain(phone.slice(1));
    });

    it('an organisation (scope) uses at most its share; the default share is a quarter', async () => {
      const now = 5_000_000;
      const cap = createSmsCap({ redis, prefix: config.redisPrefix, max: 4, now: () => now });
      const phone = testPhone();
      const decisions = [];
      for (const key of ['a', 'b', 'c']) decisions.push(await cap.reserve(phone, key, 'org-1'));
      expect(decisions).toEqual(['ok', 'scope-cap', 'scope-cap']);
      expect(await cap.reserve(phone, 'a', 'org-1')).toBe('ok'); // a retry
      for (const key of ['d', 'e', 'f']) expect(await cap.reserve(phone, key, key)).toBe('ok');
      expect(await cap.reserve(phone, 'g', 'org-9')).toBe('number-cap');
      expect(defaultPerScopeMax(20)).toBe(5);
      expect(defaultPerScopeMax(1)).toBe(1);
    });

    it('uses Redis time by default and fails open when Redis is unavailable', async () => {
      const cap = createSmsCap({ redis, prefix: config.redisPrefix, max: 1 });
      const phone = testPhone();
      expect(await cap.allow(phone, 'x')).toBe(true);
      expect(await cap.allow(phone, 'y')).toBe(false);
      const broken = createRedisClient('redis://127.0.0.1:1');
      const errors: unknown[] = [];
      const failOpen = createSmsCap({
        redis: broken,
        prefix: config.redisPrefix,
        max: 1,
        onError: (err) => errors.push(err),
      });
      try {
        expect(await failOpen.allow(phone, 'z')).toBe(true);
        expect(errors).toHaveLength(1);
      } finally {
        broken.disconnect();
      }
    });
  });

  describe('removeTicketJobs (e2e teardown)', () => {
    it('removes the waiting and delayed jobs of the given tickets only', async () => {
      const gone = randomUUID();
      const kept = randomUUID();
      const p1Since = new Date().toISOString();
      await queues.enqueueEvent({ event: 'ticket-created', ticketId: gone });
      await queues.enqueueEvent({ event: 'ticket-created', ticketId: kept });
      await queues.scheduleEscalation({ ticketId: gone, p1Since, step: 2 }, 60_000);
      await queues.scheduleEscalation({ ticketId: kept, p1Since, step: 2 }, 60_000);
      const removed = await removeTicketJobs({
        connection: redis,
        prefix: queues.prefix,
        ticketIds: [gone],
      });
      expect(removed).toBe(2);
      const left = [
        ...(await allJobs(queues.notifications)),
        ...(await allJobs(queues.escalation)),
      ].map((j) => j.data.ticketId);
      expect(left.sort()).toEqual([kept, kept]);
      expect(await queues.escalation.getJob(escalationJobId(kept, p1Since, 2))).toBeTruthy();
      expect(
        await removeTicketJobs({ connection: redis, prefix: queues.prefix, ticketIds: [] }),
      ).toBe(0);
    });
  });
});
