import { randomUUID } from 'node:crypto';
import type { Job, Queue } from 'bullmq';
import type { Prisma } from '@loons/db';
import type { WorkerContext } from '../src/jobs/context.ts';
import {
  createWorkerContext,
  startWorkers,
  type WorkerDeps,
  type Workers,
} from '../src/jobs/workers.ts';
import type { EmailProvider, OutgoingEmail } from '../src/lib/email/index.ts';
import { createLogger } from '../src/lib/logger.ts';
import type { OutgoingSms, SmsProvider } from '../src/lib/sms/index.ts';
import type { OutgoingTeamsPost, TeamsProvider } from '../src/lib/teams/index.ts';
import { createBullConnection } from '../src/lib/redis.ts';
import { rand, type TestContext } from './helpers.ts';

// Phase 3 worker fixtures: workers wired to a test context (its prefix, database and config),
// recording fake providers, escalation rules for a test team and polling helpers.

export interface FakeEmail {
  sent: OutgoingEmail[];
  provider: EmailProvider;
  /** Make the next `n` sends fail with `error`. */
  failNext(n: number, error?: string): void;
}

export function fakeEmail(): FakeEmail {
  const sent: OutgoingEmail[] = [];
  let failures = 0;
  let failure = 'SMTP 451 temporary failure';
  return {
    sent,
    failNext(n, error) {
      failures = n;
      if (error) failure = error;
    },
    provider: {
      name: 'smtp',
      async send(message) {
        if (failures > 0) {
          failures -= 1;
          throw new Error(failure);
        }
        sent.push(message);
        return { messageId: `fake-${randomUUID()}` };
      },
      async close() {},
    },
  };
}

export function fakeSms(): { sent: OutgoingSms[]; provider: SmsProvider } {
  const sent: OutgoingSms[] = [];
  return {
    sent,
    provider: {
      name: 'console',
      async send(message) {
        sent.push(message);
        return { messageId: `sms-${randomUUID()}` };
      },
      async close() {},
    },
  };
}

export function fakeTeams(): { posts: OutgoingTeamsPost[]; provider: TeamsProvider } {
  const posts: OutgoingTeamsPost[] = [];
  return {
    posts,
    provider: {
      name: 'console',
      describe: () => 'console',
      async post(post) {
        posts.push(post);
        return { status: 'sent', messageId: `teams-${randomUUID()}` };
      },
    },
  };
}

export type TestWorkerOptions = Partial<
  Pick<
    WorkerDeps,
    | 'emailProvider'
    | 'smsProvider'
    | 'teamsProvider'
    | 'now'
    | 'escalationMinuteMs'
    | 'concurrency'
    | 'storage'
    | 'smsCap'
  >
>;

/** Workers on the context's queues (same prefix), database and config; close them first. */
export async function startTestWorkers(
  ctx: TestContext,
  options: TestWorkerOptions = {},
): Promise<Workers> {
  const logger = createLogger(ctx.config, 'test-worker');
  const workers = startWorkers({
    createConnection: (name) => createBullConnection(ctx.config.redisUrl, logger, name),
    redis: ctx.redis,
    emailProvider: options.emailProvider ?? fakeEmail().provider,
    logger,
    prefix: ctx.queues.prefix,
    prisma: ctx.prisma,
    smsProvider: options.smsProvider ?? fakeSms().provider,
    teamsProvider: options.teamsProvider ?? fakeTeams().provider,
    queues: ctx.queues,
    ticketConfig: ctx.app.services.ticketConfig,
    config: ctx.config,
    ...(options.now ? { now: options.now } : {}),
    ...(options.escalationMinuteMs !== undefined
      ? { escalationMinuteMs: options.escalationMinuteMs }
      : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
    ...(options.smsCap ? { smsCap: options.smsCap } : {}),
  });
  await workers.ready();
  return workers;
}

/**
 * A P1 chain for a test team (team rules replace the global chain, D3): step 1 on-call at 0,
 * step 2 team leads at 5, step 3 a user at 15 — like the seeded one, but paging test users.
 */
export async function testChain(
  ctx: TestContext,
  teamId: string,
  managerId: string,
  steps: Array<Partial<Prisma.EscalationRuleUncheckedCreateInput>> = [],
) {
  const defaults: Prisma.EscalationRuleUncheckedCreateInput[] = [
    {
      priority: 'P1',
      teamId,
      step: 1,
      targetType: 'ON_CALL',
      afterMins: 0,
      channels: ['EMAIL', 'TEAMS', 'SMS'],
    },
    {
      priority: 'P1',
      teamId,
      step: 2,
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
      afterMins: 5,
      channels: ['EMAIL', 'TEAMS', 'SMS'],
    },
    {
      priority: 'P1',
      teamId,
      step: 3,
      targetType: 'USER',
      targetUserId: managerId,
      afterMins: 15,
      channels: ['EMAIL', 'SMS'],
    },
  ];
  const rules = steps.length ? steps.map((s, i) => ({ ...defaults[i]!, ...s })) : defaults;
  // Rules cascade with the team (fixtures' cleanup).
  await ctx.prisma.escalationRule.createMany({ data: rules });
}

/** Resolves once `fn` returns a truthy value (polling), or throws after `timeout` ms. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  { timeout = 15_000, interval = 50, what = 'condition' } = {},
): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every job of a queue in any state (for assertions on ids). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function allJobs(queue: Queue<any>): Promise<Job[]> {
  const jobs = await queue.getJobs([
    'waiting',
    'delayed',
    'prioritized',
    'active',
    'completed',
    'failed',
    'waiting-children',
  ]);
  return jobs.filter((j): j is Job => j !== undefined);
}

/** A unique E.164 test number (+97450xxxxxxx). */
export function testPhone(): string {
  return `+9745${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

export const uniq = () => rand(4);

/** A processor context on the test context (no BullMQ workers: enqueued jobs stay queued). */
export function testWorkerContext(
  ctx: TestContext,
  options: TestWorkerOptions & { publish?: WorkerDeps['publish'] } = {},
): WorkerContext {
  return createWorkerContext({
    redis: ctx.redis,
    emailProvider: options.emailProvider ?? fakeEmail().provider,
    logger: createLogger(ctx.config, 'test-worker'),
    prisma: ctx.prisma,
    smsProvider: options.smsProvider ?? fakeSms().provider,
    teamsProvider: options.teamsProvider ?? fakeTeams().provider,
    queues: ctx.queues,
    ticketConfig: ctx.app.services.ticketConfig,
    config: ctx.config,
    ...(options.now ? { now: options.now } : {}),
    ...(options.escalationMinuteMs !== undefined
      ? { escalationMinuteMs: options.escalationMinuteMs }
      : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
    ...(options.smsCap ? { smsCap: options.smsCap } : {}),
    ...(options.publish ? { publish: options.publish } : {}),
  });
}
