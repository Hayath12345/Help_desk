import { Queue, type ConnectionOptions, type DefaultJobOptions, type JobsOptions } from 'bullmq';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import {
  ESCALATION_JOB,
  NOTIFICATION_JOBS,
  deliveryJobId,
  deliveryJobSchema,
  escalationJobId,
  escalationJobSchema,
  notificationEventJobId,
  notificationEventSchema,
  type DeliveryJob,
  type DeliveryJobInput,
  type EscalationJob,
  type NotificationEvent,
  type SlaJob,
} from './job-data.ts';

// BullMQ queues shared by the API (producer) and the worker (consumer and producer).

export const QUEUE_NAMES = {
  email: 'email',
  notifications: 'notifications',
  sla: 'sla',
  /** Delayed P1 escalation steps (D3); its own queue so a slow SLA scan never delays a page. */
  escalation: 'escalation',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** BullMQ key prefix (keys look like `loons:bull:email:…`). */
export const DEFAULT_QUEUE_PREFIX = 'loons:bull';

/** The BullMQ prefix of an app configuration: `<redisPrefix>bull` ("loons:bull"). */
export function queuePrefixFor(config: Pick<AppConfig, 'redisPrefix'>): string {
  return `${config.redisPrefix}bull`;
}

/** Redis list holding dead-letter records (newest first, capped). */
export const DEAD_LETTER_LIST = 'dead-letter';
export const DEAD_LETTER_MAX = 10_000;

export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

/**
 * P1 escalation steps retry for about 30 minutes (every 30 s) instead of the default ~150 s: each
 * step schedules the next one only when it succeeds, so a step that dead-letters during a short
 * database or Redis outage would end the chain while the P1 is still unacknowledged. (The SLA
 * scan's safety net also re-schedules a step that is overdue and has no live job.)
 */
export const ESCALATION_JOB_OPTIONS = {
  attempts: 60,
  backoff: { type: 'fixed', delay: 30_000 },
} as const satisfies Pick<JobsOptions, 'attempts' | 'backoff'>;

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

/** `event` (NotificationEvent) and `deliver` (DeliveryJob) jobs. */
export type NotificationJobData = NotificationEvent | DeliveryJob;
export type SlaJobData = SlaJob;

export interface AppQueues {
  prefix: string;
  email: Queue<EmailJobData, EmailJobResult>;
  notifications: Queue<NotificationJobData>;
  sla: Queue<SlaJobData>;
  escalation: Queue<EscalationJob>;
  /** Adds an email job. A deterministic `jobId` (no ":" allowed by BullMQ) makes the enqueue idempotent. */
  enqueueEmail(
    data: EmailJobData,
    opts?: Pick<JobsOptions, 'jobId' | 'delay' | 'priority' | 'removeOnComplete' | 'removeOnFail'>,
  ): Promise<string>;
  /** A ticket event for the notifications fan-out (deterministic job id). */
  enqueueEvent(event: NotificationEvent): Promise<string>;
  /** One delivery (its `NotificationDelivery` row must exist). */
  enqueueDelivery(job: DeliveryJobInput): Promise<string>;
  /** A P1 escalation step, delayed by `delayMs` (deterministic job id). */
  scheduleEscalation(job: EscalationJob, delayMs: number): Promise<string>;
  /**
   * Removes waiting / delayed jobs by id (best effort: an id that is gone is ignored, one that is
   * running is left — the processors re-check the ticket anyway). Resolves to how many went.
   */
  removeJobs(
    queue: 'notifications' | 'escalation' | 'sla',
    ids: readonly string[],
  ): Promise<number>;
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
  const escalation = new Queue<EscalationJob>(QUEUE_NAMES.escalation, common);
  const all = [email, notifications, sla, escalation];
  // Errors surface on the calls themselves; this only prevents unhandled 'error' events.
  for (const q of all) q.on('error', () => undefined);
  const byName = { notifications, escalation, sla } as const;

  return {
    prefix,
    email,
    notifications,
    sla,
    escalation,
    async enqueueEmail(data, opts = {}) {
      const payload = emailJobSchema.parse(data);
      const job = await email.add('send', payload, opts);
      return job.id ?? '';
    },
    async enqueueEvent(event) {
      const payload = notificationEventSchema.parse(event);
      const jobId = notificationEventJobId(payload);
      await notifications.add(NOTIFICATION_JOBS.event, payload, { jobId });
      return jobId;
    },
    async enqueueDelivery(job) {
      const payload = deliveryJobSchema.parse(job);
      const jobId = deliveryJobId(payload.dedupeKey);
      await notifications.add(NOTIFICATION_JOBS.deliver, payload, { jobId });
      return jobId;
    },
    async scheduleEscalation(job, delayMs) {
      const payload = escalationJobSchema.parse(job);
      const jobId = escalationJobId(payload.ticketId, payload.p1Since, payload.step);
      await escalation.add(ESCALATION_JOB, payload, {
        ...ESCALATION_JOB_OPTIONS,
        jobId,
        delay: Math.max(0, Math.round(delayMs)),
      });
      return jobId;
    },
    async removeJobs(queue, ids) {
      const q = byName[queue];
      let removed = 0;
      for (const id of ids) {
        try {
          removed += await q.remove(id);
        } catch {
          // Locked (running) or already finishing: the processor re-checks the ticket.
        }
      }
      return removed;
    },
    async close() {
      await Promise.allSettled(all.map((q) => q.close()));
    },
  };
}
