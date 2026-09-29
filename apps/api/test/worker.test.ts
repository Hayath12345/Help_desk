import { QueueEvents, UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderTemplateEmail } from '@loons/emails';
import {
  SCHEDULER_INTERVALS,
  dailyPattern,
  registerSchedulers,
  scheduledTickTime,
  upsertSchedulerIfChanged,
} from '../src/jobs/schedulers.ts';
import { startWorkers, type Workers } from '../src/jobs/workers.ts';
import { createEmailProvider, type EmailProvider } from '../src/lib/email/index.ts';
import { createLogger } from '../src/lib/logger.ts';
import { DEAD_LETTER_LIST, createQueues, type AppQueues } from '../src/lib/queues.ts';
import { closeRedis, createBullConnection } from '../src/lib/redis.ts';
import { createTestContext, rand, testEmail, type TestContext } from './helpers.ts';
import { fakeSms, fakeTeams, startTestWorkers } from './worker-helpers.ts';

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
  let ctx: TestContext;
  let config: TestContext['config'];
  let logger: ReturnType<typeof createLogger>;
  let prefix: string;
  let redis: TestContext['redis'];
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
    ctx = await createTestContext();
    config = ctx.config;
    logger = createLogger(config, 'worker-test');
    prefix = ctx.queues.prefix;
    redis = ctx.redis;
    queues = ctx.queues;
    provider = createEmailProvider(config); // SMTP → Mailpit (EMAIL_PROVIDER=smtp in .env)
    workers = await startTestWorkers(ctx, { emailProvider: provider });
    events = new QueueEvents('email', { connection: bullConn(), prefix });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await workers.close();
    await events.close();
    await redis.del(`${prefix}:${DEAD_LETTER_LIST}`);
    await Promise.all(extraConnections.map((c) => closeRedis(c)));
    await provider.close();
    await deleteFromMailpit(mailpitIds);
    await ctx.close();
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

  it('the sla queue runs its scheduled job types; an unknown job fails without retries', async () => {
    const qe = new QueueEvents('sla', { connection: bullConn(), prefix });
    await qe.waitUntilReady();
    try {
      // Scoped to a team that has nothing (never the whole dev database).
      const teamIds = [(await ctx.fixtures.team()).id];
      const job = await queues.sla.add('retention', { teamIds });
      expect(await job.waitUntilFinished(qe, 10_000)).toEqual({ deliveries: 0, notifications: 0 });

      const unknown = await queues.sla.add('noop', {}, { attempts: 3 });
      await expect(unknown.waitUntilFinished(qe, 10_000)).rejects.toThrow(/unknown sla job/);
      const failed = await queues.sla.getJob(unknown.id!);
      expect(failed?.attemptsMade).toBe(1);

      const invalid = await queues.sla.add(
        'sla-scan',
        { teamIds: ['not-a-uuid'] },
        { attempts: 3 },
      );
      await expect(invalid.waitUntilFinished(qe, 10_000)).rejects.toThrow(
        /invalid sla job payload/,
      );
      expect(new UnrecoverableError('x').name).toBe('UnrecoverableError');
    } finally {
      await qe.close();
    }
  });

  it('registers the five schedulers with fixed ids (idempotent) and the digest cron in the business zone', async () => {
    const schedPrefix = `${config.redisPrefix}bull-sched`;
    const schedQueues = createQueues({ connection: redis, prefix: schedPrefix });
    try {
      const options = { timeZone: 'Asia/Qatar', digestTime: '07:30' };
      await registerSchedulers(schedQueues.sla, options);
      await registerSchedulers(schedQueues.sla, options);
      const schedulers = await schedQueues.sla.getJobSchedulers();
      expect(schedulers.map((s) => s.key).sort()).toEqual(
        ['auto-close', 'orphan-sweep', 'p4-digest', 'retention', 'sla-scan'].sort(),
      );
      const byKey = new Map(schedulers.map((s) => [s.key, s]));
      expect(Number(byKey.get('sla-scan')?.every)).toBe(SCHEDULER_INTERVALS.slaScanMs);
      expect(Number(byKey.get('auto-close')?.every)).toBe(15 * 60_000);
      expect(Number(byKey.get('orphan-sweep')?.every)).toBe(30 * 60_000);
      expect(byKey.get('p4-digest')?.pattern).toBe('30 7 * * *');
      expect(byKey.get('p4-digest')?.tz).toBe('Asia/Qatar');
      expect(dailyPattern('16:05')).toBe('5 16 * * *');
    } finally {
      await Promise.allSettled([schedQueues.sla.obliterate({ force: true })]);
      await schedQueues.close();
    }
  });

  it('a tick that came due while no worker ran survives a worker restart (re-registration)', async () => {
    const schedPrefix = `${config.redisPrefix}bull-sched2`;
    const schedQueues = createQueues({ connection: redis, prefix: schedPrefix });
    try {
      // Every 2 seconds (6-field cron), so the first tick is overdue almost at once; no worker.
      const repeat = { pattern: '*/2 * * * * *', tz: 'Asia/Qatar' };
      expect(await upsertSchedulerIfChanged(schedQueues.sla, 'p4-digest', repeat, {})).toBe(true);
      const pending = async () =>
        (await schedQueues.sla.getJobs(['delayed', 'waiting', 'prioritized'])).filter(
          (j) => j?.name === 'p4-digest',
        );
      const [tick] = await pending();
      const due = tick!.timestamp + (tick!.opts.delay ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 300));
      // The worker (re)starts and registers the same schedulers: the overdue tick stays.
      expect(await upsertSchedulerIfChanged(schedQueues.sla, 'p4-digest', repeat, {})).toBe(false);
      expect((await pending()).map((j) => j!.id)).toEqual([tick!.id]);
      // It is still due at its own time (the digest window is worked out from it).
      expect(scheduledTickTime(tick!, new Date(due + 3_600_000)).getTime()).toBe(due);
      // A changed schedule is written.
      expect(
        await upsertSchedulerIfChanged(schedQueues.sla, 'p4-digest', { ...repeat, tz: 'UTC' }, {}),
      ).toBe(true);
    } finally {
      await Promise.allSettled([schedQueues.sla.obliterate({ force: true })]);
      await schedQueues.close();
    }
  });

  it('scheduledTickTime: a scheduler tick is dated when it was due; other jobs use the clock', () => {
    const now = new Date('2026-10-04T08:15:00Z');
    const due = Date.parse('2026-10-04T04:30:00Z');
    const tick = {
      repeatJobKey: 'p4-digest',
      timestamp: due - 86_400_000,
      opts: { delay: 86_400_000 },
    };
    expect(scheduledTickTime(tick, now).toISOString()).toBe('2026-10-04T04:30:00.000Z');
    expect(scheduledTickTime({ ...tick, repeatJobKey: undefined }, now)).toBe(now);
    expect(scheduledTickTime({ ...tick, opts: {} }, now)).toBe(now);
    // Never in the future.
    expect(scheduledTickTime(tick, new Date(due - 1000)).getTime()).toBe(due - 1000);
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
      prisma: ctx.prisma,
      smsProvider: fakeSms().provider,
      teamsProvider: fakeTeams().provider,
      queues: failQueues,
      ticketConfig: ctx.app.services.ticketConfig,
      config,
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
        [failQueues.email, failQueues.notifications, failQueues.sla, failQueues.escalation].map(
          (q) => q.obliterate({ force: true }),
        ),
      );
      await failQueues.close();
    }
  });
});
