import { Worker, type Job, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EmailProvider } from '../lib/email/index.ts';
import type { AppLogger } from '../lib/logger.ts';
import { DEFAULT_QUEUE_PREFIX, QUEUE_NAMES, type QueueName } from '../lib/queues.ts';
import { isFinalFailure, recordDeadLetter } from './dead-letter.ts';
import { createEmailProcessor } from './email.ts';
import { createPlaceholderProcessor } from './placeholders.ts';

export interface WorkerDeps {
  /** Creates a dedicated connection (maxRetriesPerRequest: null) for each Worker. */
  createConnection: (name: string) => Redis;
  /** Regular connection for dead-letter records. */
  redis: Redis;
  emailProvider: EmailProvider;
  logger: AppLogger;
  prefix?: string;
  concurrency?: Partial<Record<QueueName, number>>;
}

export interface Workers {
  workers: Worker[];
  /** Resolves once every worker is connected and consuming. */
  ready(): Promise<void>;
  close(): Promise<void>;
}

export function startWorkers(deps: WorkerDeps): Workers {
  const prefix = deps.prefix ?? DEFAULT_QUEUE_PREFIX;
  const connections: Redis[] = [];
  const placeholder = createPlaceholderProcessor(deps.logger);

  const definitions: Array<{ name: QueueName; processor: Processor; concurrency: number }> = [
    {
      name: QUEUE_NAMES.email,
      processor: createEmailProcessor(deps.emailProvider, deps.logger) as Processor,
      concurrency: deps.concurrency?.email ?? 5,
    },
    {
      name: QUEUE_NAMES.notifications,
      processor: placeholder,
      concurrency: deps.concurrency?.notifications ?? 5,
    },
    { name: QUEUE_NAMES.sla, processor: placeholder, concurrency: deps.concurrency?.sla ?? 1 },
  ];

  const workers = definitions.map(({ name, processor, concurrency }) => {
    const connection = deps.createConnection(`worker-${name}`);
    connections.push(connection);
    const worker = new Worker(name, processor, { connection, prefix, concurrency, autorun: true });

    worker.on('failed', (job: Job | undefined, err: Error) => {
      if (!job) return;
      if (isFinalFailure(job)) {
        void recordDeadLetter({ redis: deps.redis, prefix, logger: deps.logger }, job, err);
      } else {
        deps.logger.warn(
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
      deps.logger.error({ err, queue: name }, 'worker error');
    });
    return worker;
  });

  return {
    workers,
    async ready() {
      await Promise.all(workers.map((w) => w.waitUntilReady()));
    },
    async close() {
      await Promise.allSettled(workers.map((w) => w.close()));
      await Promise.allSettled(connections.map((c) => c.quit()));
    },
  };
}
