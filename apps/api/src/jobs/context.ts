import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Prisma, PrismaClient } from '@loons/db';
import type { NotificationData, NotificationType } from '@loons/shared';
import type { EmailProvider } from '../lib/email/index.ts';
import type { DeliveryJobInput } from '../lib/job-data.ts';
import type { AppLogger } from '../lib/logger.ts';
import type { AppQueues } from '../lib/queues.ts';
import type { SmsProvider } from '../lib/sms/index.ts';
import type { SmsCap } from '../lib/sms-cap.ts';
import type { Storage } from '../lib/storage.ts';
import type { TeamsProvider } from '../lib/teams/index.ts';
import type { WorkerEventPublisher } from '../lib/worker-events.ts';
import type { TicketConfigService } from '../services/ticket-config.service.ts';

/** What the Phase 3 processors need (built once per worker process by `startWorkers`). */
export interface WorkerContext {
  prisma: PrismaClient;
  /** Regular Redis connection: delivery locks, the SMS cap, worker events. */
  redis: Redis;
  /** `AppConfig.redisPrefix` (lock / cap keys, the worker-events channel). */
  redisPrefix: string;
  /** Producer side: deliveries and the next escalation step. */
  queues: AppQueues;
  logger: AppLogger;
  /** Absolute links in emails, Teams cards and texts (`APP_URL`). */
  appUrl: string;
  email: EmailProvider;
  sms: SmsProvider;
  teams: TeamsProvider;
  smsCap: SmsCap;
  /** Object storage for the orphan sweep (null: rows only). */
  storage: Pick<Storage, 'deleteObject'> | null;
  /** SLA policies, SOC phone and the business calendar (Redis-cached, like the API). */
  ticketConfig: TicketConfigService;
  /** The clock (tests inject one). */
  now: () => Date;
  /** Length of an escalation "minute" (tests shrink it). */
  minuteMs: number;
  publish: WorkerEventPublisher;
}

/** Short stable hash for dedupe keys (e.g. a distribution-list address; no PII in the key). */
export function keyHash(value: string): string {
  return createHash('sha256').update(value.toLowerCase()).digest('hex').slice(0, 16);
}

export interface PlannedDelivery {
  job: DeliveryJobInput;
  /** E-mail address as is, phone masked, webhook host only (contract). */
  recipientMasked: string;
}

/**
 * Records the deliveries (QUEUED; an existing dedupe key is left alone) and enqueues one job per
 * delivery. Safe to repeat: the rows and the job ids are deterministic, and a delivery that was
 * already sent is never sent again.
 */
export async function queueDeliveries(
  ctx: WorkerContext,
  planned: PlannedDelivery[],
): Promise<void> {
  if (planned.length === 0) return;
  await ctx.prisma.notificationDelivery.createMany({
    data: planned.map(({ job, recipientMasked }) => ({
      channel: job.channel,
      templateKey: job.template,
      ticketId: job.ticketId ?? null,
      userId: job.userId ?? null,
      teamId: job.teamId ?? null,
      recipientMasked: recipientMasked.slice(0, 320),
      dedupeKey: job.dedupeKey,
    })),
    skipDuplicates: true,
  });
  for (const { job } of planned) await ctx.queues.enqueueDelivery(job);
}

export interface PlannedInApp {
  userId: string;
  type: NotificationType;
  ticketId: string | null;
  data: NotificationData;
  dedupeKey: string;
}

/**
 * Creates in-app notifications (one per dedupe key, ever) and publishes `notification:new` for
 * the ones this call created. Returns how many were new.
 */
export async function createInApp(ctx: WorkerContext, items: PlannedInApp[]): Promise<number> {
  let created = 0;
  for (const item of items) {
    const { count } = await ctx.prisma.notification.createMany({
      data: [
        {
          userId: item.userId,
          type: item.type,
          ticketId: item.ticketId,
          data: item.data as Prisma.InputJsonObject,
          dedupeKey: item.dedupeKey,
          createdAt: ctx.now(),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) continue;
    created += 1;
    const row = await ctx.prisma.notification.findUnique({
      where: { dedupeKey: item.dedupeKey },
      select: { id: true },
    });
    if (row)
      await ctx.publish({ kind: 'notification', notificationId: row.id, userId: item.userId });
  }
  return created;
}
