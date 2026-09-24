import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderTemplateEmail } from '@loons/emails';
import { startWorkers, type Workers } from '../src/jobs/workers.ts';
import { createEmailProvider, type EmailProvider } from '../src/lib/email/index.ts';
import { createLogger } from '../src/lib/logger.ts';
import { DEAD_LETTER_LIST, createQueues, type AppQueues } from '../src/lib/queues.ts';
import { closeRedis, createBullConnection, createRedisClient } from '../src/lib/redis.ts';
import { rand, testConfig, testEmail } from './helpers.ts';

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025/api/v1';

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

async function findInMailpit(subject: string): Promise<MailpitMessage[]> {
  const res = await fetch(
    `${MAILPIT_API}/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
  );
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  const body = (await res.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

async function deleteFromMailpit(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${MAILPIT_API}/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  });
}

describe('worker', () => {
  const config = testConfig();
  const logger = createLogger(config, 'worker-test');
  const prefix = `${config.redisPrefix}bull`;
  const redis = createRedisClient(config.redisUrl, logger, 'worker-test');
  let queues: AppQueues;
  let workers: Workers;
  let events: QueueEvents;
  let provider: EmailProvider;
  const mailpitIds: string[] = [];
  const extraConnections: ReturnType<typeof createBullConnection>[] = [];
  const bullConn = () => {
    const c = createBullConnection(config.redisUrl);
    extraConnections.push(c);
    return c;
  };

  beforeAll(async () => {
    provider = createEmailProvider(config); // SMTP → Mailpit (EMAIL_PROVIDER=smtp in .env)
    queues = createQueues({ connection: redis, prefix });
    workers = startWorkers({
      createConnection: (name) => createBullConnection(config.redisUrl, logger, name),
      redis,
      emailProvider: provider,
      logger,
      prefix,
    });
    events = new QueueEvents('email', { connection: bullConn(), prefix });
    await Promise.all([workers.ready(), events.waitUntilReady()]);
  });

  afterAll(async () => {
    await workers.close();
    await events.close();
    await Promise.allSettled(
      [queues.email, queues.notifications, queues.sla].map((q) => q.obliterate({ force: true })),
    );
    await queues.close();
    await redis.del(`${prefix}:${DEAD_LETTER_LIST}`);
    await Promise.all(extraConnections.map((c) => closeRedis(c)));
    await closeRedis(redis);
    await provider.close();
    await deleteFromMailpit(mailpitIds);
  });

  it('delivers a queued email through SMTP to Mailpit', async () => {
    expect(config.email.provider).toBe('smtp');
    const subject = `Loons worker test ${rand()}`;
    const to = testEmail();
    const rendered = await renderTemplateEmail({
      locale: 'en',
      subject,
      body: 'Hello {{name}},\n\nThis is an automated test.',
      variables: { name: 'Tester' },
    });
    const job = await queues.email.add(
      'send',
      { to, ...rendered, tag: 'test' },
      { jobId: `test-${rand()}` },
    );
    const result = await job.waitUntilFinished(events, 20_000);
    expect(result.messageId).toBeTruthy();

    await expect
      .poll(async () => (await findInMailpit(subject)).length, { timeout: 10_000, interval: 250 })
      .toBe(1);
    const [message] = await findInMailpit(subject);
    mailpitIds.push(message!.ID);
    expect(message!.To.map((t) => t.Address)).toEqual([to]);
  });

  it('enqueueing the same jobId twice is idempotent', async () => {
    const jobId = `idempotent-${rand()}`;
    const payload = { to: testEmail(), subject: 'Idempotency', html: '<p>x</p>', text: 'x' };
    await queues.email.pause();
    try {
      const a = await queues.enqueueEmail(payload, { jobId });
      const b = await queues.enqueueEmail(payload, { jobId });
      expect(a).toBe(jobId);
      expect(b).toBe(jobId);
      expect(await queues.email.getWaitingCount()).toBe(1);
      await queues.email.remove(jobId);
    } finally {
      await queues.email.resume();
    }
  });

  it('placeholder queues consume jobs', async () => {
    const qe = new QueueEvents('sla', { connection: bullConn(), prefix });
    await qe.waitUntilReady();
    try {
      const job = await queues.sla.add('noop', { hello: 'world' });
      expect(await job.waitUntilFinished(qe, 10_000)).toEqual({ skipped: true });
    } finally {
      await qe.close();
    }
  });

  it('a job that fails for good is dead-lettered without PII', async () => {
    const failPrefix = `${config.redisPrefix}bull-fail`;
    const failing: EmailProvider = {
      name: 'smtp',
      async send(message) {
        throw new Error(`550 mailbox unavailable for ${message.to}`);
      },
      async close() {},
    };
    const failQueues = createQueues({ connection: redis, prefix: failPrefix });
    const failWorkers = startWorkers({
      createConnection: (name) => createBullConnection(config.redisUrl, logger, name),
      redis,
      emailProvider: failing,
      logger,
      prefix: failPrefix,
    });
    const failEvents = new QueueEvents('email', { connection: bullConn(), prefix: failPrefix });
    try {
      await Promise.all([failWorkers.ready(), failEvents.waitUntilReady()]);
      const to = testEmail();
      const job = await failQueues.email.add(
        'send',
        { to, subject: 'Will fail', html: '<p>x</p>', text: 'x' },
        { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );
      await expect(job.waitUntilFinished(failEvents, 20_000)).rejects.toThrow();

      const key = `${failPrefix}:${DEAD_LETTER_LIST}`;
      await expect.poll(async () => redis.llen(key), { timeout: 5_000 }).toBe(1);
      const [raw] = await redis.lrange(key, 0, 0);
      const record = JSON.parse(raw!);
      expect(record).toMatchObject({ queue: 'email', jobId: job.id, name: 'send', attempts: 2 });
      expect(record.error).toContain('[email]');
      expect(raw).not.toContain(to);
      await redis.del(key);
    } finally {
      await failWorkers.close();
      await failEvents.close();
      await Promise.allSettled(
        [failQueues.email, failQueues.notifications, failQueues.sla].map((q) =>
          q.obliterate({ force: true }),
        ),
      );
      await failQueues.close();
    }
  });
});
