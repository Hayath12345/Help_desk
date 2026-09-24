import { Queue, type ConnectionOptions, type DefaultJobOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';

// BullMQ queues shared by the API (producer) and the worker (consumer).

export const QUEUE_NAMES = {
  email: 'email',
  notifications: 'notifications',
  sla: 'sla',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** BullMQ key prefix (keys look like `loons:bull:email:…`). */
export const DEFAULT_QUEUE_PREFIX = 'loons:bull';

/** Redis list holding dead-letter records (newest first, capped). */
export const DEAD_LETTER_LIST = 'dead-letter';
export const DEAD_LETTER_MAX = 10_000;

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

export const emailJobSchema = z.object({
  to: z.email(),
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  text: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** Non-PII label for logs / metrics, e.g. "password-reset". */
  tag: z.string().max(64).optional(),
});
export type EmailJobData = z.infer<typeof emailJobSchema>;
export interface EmailJobResult {
  messageId: string;
}

/** Phase 2–3 payloads; processors are placeholders for now. */
export type NotificationJobData = Record<string, unknown>;
export type SlaJobData = Record<string, unknown>;

export interface AppQueues {
  prefix: string;
  email: Queue<EmailJobData, EmailJobResult>;
  notifications: Queue<NotificationJobData>;
  sla: Queue<SlaJobData>;
  /** Adds an email job. A deterministic `jobId` (no ":" allowed by BullMQ) makes the enqueue idempotent. */
  enqueueEmail(
    data: EmailJobData,
    opts?: Pick<JobsOptions, 'jobId' | 'delay' | 'priority' | 'removeOnComplete' | 'removeOnFail'>,
  ): Promise<string>;
  close(): Promise<void>;
}

export function createQueues(options: {
  connection: ConnectionOptions;
  prefix?: string;
}): AppQueues {
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const common = { connection: options.connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS };
  const email = new Queue<EmailJobData, EmailJobResult>(QUEUE_NAMES.email, common);
  const notifications = new Queue<NotificationJobData>(QUEUE_NAMES.notifications, common);
  const sla = new Queue<SlaJobData>(QUEUE_NAMES.sla, common);
  // Errors surface on the calls themselves; this only prevents unhandled 'error' events.
  for (const q of [email, notifications, sla]) q.on('error', () => undefined);

  return {
    prefix,
    email,
    notifications,
    sla,
    async enqueueEmail(data, opts = {}) {
      const payload = emailJobSchema.parse(data);
      const job = await email.add('send', payload, opts);
      return job.id ?? '';
    },
    async close() {
      await Promise.allSettled([email.close(), notifications.close(), sla.close()]);
    },
  };
}
