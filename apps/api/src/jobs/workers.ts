import { UnrecoverableError, Worker, type Job, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import type { AppConfig } from '../config.ts';
import type { EmailProvider } from '../lib/email/index.ts';
import { MINUTE_MS } from '../lib/escalation.ts';
import {
  ESCALATION_JOB,
  NOTIFICATION_JOBS,
  SLA_JOBS,
  deliveryJobSchema,
  escalationJobSchema,
  notificationEventSchema,
  slaJobSchema,
} from '../lib/job-data.ts';
import type { AppLogger } from '../lib/logger.ts';
import {
  DEFAULT_QUEUE_PREFIX,
  QUEUE_NAMES,
  type AppQueues,
  type QueueName,
} from '../lib/queues.ts';
import type { SmsProvider } from '../lib/sms/index.ts';
import { createSmsCap, type SmsCap } from '../lib/sms-cap.ts';
import type { Storage } from '../lib/storage.ts';
import type { TeamsProvider } from '../lib/teams/index.ts';
import { createWorkerEventPublisher, type WorkerEventPublisher } from '../lib/worker-events.ts';
import type { TicketConfigService } from '../services/ticket-config.service.ts';
import type { WorkerContext } from './context.ts';
import { isFinalFailure, recordDeadLetter } from './dead-letter.ts';
import { processDelivery } from './deliver.ts';
import { createEmailProcessor } from './email.ts';
import { processEscalationStep } from './escalation.ts';
import { processNotificationEvent } from './events.ts';
import { runAutoClose, runDigest, runOrphanSweep, runRetention } from './maintenance.ts';
import { scheduledTickTime } from './schedulers.ts';
import { runSlaScan } from './sla-scan.ts';

export interface WorkerDeps {
  /** Creates a dedicated connection (maxRetriesPerRequest: null) for each Worker. */
  createConnection: (name: string) => Redis;
  /** Regular connection: dead-letter records, delivery locks, the SMS cap, worker events. */
  redis: Redis;
  emailProvider: EmailProvider;
  logger: AppLogger;
  prefix?: string;
  concurrency?: Partial<Record<QueueName, number>>;
  prisma: PrismaClient;
  smsProvider: SmsProvider;
  teamsProvider: TeamsProvider;
  /** Producer side (deliveries, the next escalation step); same prefix as `prefix`. */
  queues: AppQueues;
  ticketConfig: TicketConfigService;
  config: Pick<AppConfig, 'appUrl' | 'redisPrefix' | 'sms'>;
  /** Object storage for the orphan sweep (default none: rows only). */
  storage?: Pick<Storage, 'deleteObject'> | null;
  /** Clock (tests). */
  now?: () => Date;
  /** Length of an escalation "minute" (tests shrink it). */
  escalationMinuteMs?: number;
  smsCap?: SmsCap;
  publish?: WorkerEventPublisher;
}

export interface Workers {
  workers: Worker[];
  /** What the processors run with (tests call them directly). */
  context: WorkerContext;
  /** Resolves once every worker is connected and consuming. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

function unknownJob(job: Job): never {
  throw new UnrecoverableError(`unknown ${job.queueName} job "${job.name}"`);
}

/** Parses a payload; an invalid one never succeeds, so it fails without retries. */
function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  job: Job,
): T {
  const parsed = schema.safeParse(job.data);
  if (!parsed.success) throw new UnrecoverableError(`invalid ${job.queueName} job payload`);
  return parsed.data;
}

/** The processors' context (tests use it to run a processor directly, without BullMQ). */
export function createWorkerContext(
  deps: Omit<WorkerDeps, 'createConnection' | 'prefix' | 'concurrency'>,
): WorkerContext {
  const logger = deps.logger;
  return {
    prisma: deps.prisma,
    redis: deps.redis,
    redisPrefix: deps.config.redisPrefix,
    queues: deps.queues,
    logger,
    appUrl: deps.config.appUrl,
    email: deps.emailProvider,
    sms: deps.smsProvider,
    teams: deps.teamsProvider,
    smsCap:
      deps.smsCap ??
      createSmsCap({
        redis: deps.redis,
        prefix: deps.config.redisPrefix,
        max: deps.config.sms.maxPerRecipientPerHour,
        onError: (err) => logger.warn({ err }, 'SMS cap unavailable; sending anyway (fail open)'),
      }),
    storage: deps.storage ?? null,
    ticketConfig: deps.ticketConfig,
    now: deps.now ?? (() => new Date()),
    minuteMs: deps.escalationMinuteMs ?? MINUTE_MS,
    publish:
      deps.publish ??
      createWorkerEventPublisher({
        redis: deps.redis,
        redisPrefix: deps.config.redisPrefix,
        logger,
      }),
  };
}

export function startWorkers(deps: WorkerDeps): Workers {
  const prefix = deps.prefix ?? DEFAULT_QUEUE_PREFIX;
  const connections: Redis[] = [];
  const logger = deps.logger;
  const context = createWorkerContext(deps);

  const notifications: Processor = async (job) => {
    if (job.name === NOTIFICATION_JOBS.event) {
      return processNotificationEvent(context, parse(notificationEventSchema, job));
    }
    if (job.name === NOTIFICATION_JOBS.deliver) {
      return processDelivery(context, parse(deliveryJobSchema, job));
    }
    return unknownJob(job);
  };

  const escalation: Processor = async (job) => {
    if (job.name !== ESCALATION_JOB) return unknownJob(job);
    return processEscalationStep(context, parse(escalationJobSchema, job));
  };

  const sla: Processor = async (job) => {
    const { teamIds } = parse(slaJobSchema, job);
    const opts = { now: context.now(), teamIds };
    switch (job.name) {
      case SLA_JOBS.scan:
        return runSlaScan(context, opts);
      case SLA_JOBS.autoClose:
        return runAutoClose(context, opts);
      case SLA_JOBS.digest:
        // The window of the day the tick was due, even when it runs late (worker restart).
        return runDigest(context, { ...opts, now: scheduledTickTime(job, opts.now) });
      case SLA_JOBS.orphanSweep:
        return runOrphanSweep(context, opts);
      case SLA_JOBS.retention:
        return runRetention(context, opts);
      default:
        return unknownJob(job);
    }
  };

  const definitions: Array<{ name: QueueName; processor: Processor; concurrency: number }> = [
    {
      name: QUEUE_NAMES.email,
      processor: createEmailProcessor(deps.emailProvider, logger) as Processor,
      concurrency: deps.concurrency?.email ?? 5,
    },
    {
      name: QUEUE_NAMES.notifications,
      processor: notifications,
      concurrency: deps.concurrency?.notifications ?? 5,
    },
    {
      name: QUEUE_NAMES.escalation,
      processor: escalation,
      concurrency: deps.concurrency?.escalation ?? 5,
    },
    { name: QUEUE_NAMES.sla, processor: sla, concurrency: deps.concurrency?.sla ?? 1 },
  ];

  const workers = definitions.map(({ name, processor, concurrency }) => {
    const connection = deps.createConnection(`worker-${name}`);
    connections.push(connection);
    const worker = new Worker(name, processor, { connection, prefix, concurrency, autorun: true });

    worker.on('failed', (job: Job | undefined, err: Error) => {
      if (!job) return;
      if (isFinalFailure(job)) {
        void recordDeadLetter({ redis: deps.redis, prefix, logger }, job, err);
      } else {
        logger.warn(
          {
            queue: name,
            jobId: job.id,
            attemptsMade: job.attemptsMade,
            attempts: job.opts.attempts,
          },
          'job failed; will retry',
        );
      }
    });
    worker.on('error', (err: Error) => {
      logger.error({ err, queue: name }, 'worker error');
    });
    return worker;
  });

  return {
    workers,
    context,
    async ready() {
      await Promise.all(workers.map((w) => w.waitUntilReady()));
    },
    async close() {
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled(connections.map((c) => c.quit()));
    },
  };
}
