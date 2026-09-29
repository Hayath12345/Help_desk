import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AppLogger as Logger } from './logger.ts';

// Worker → browsers (decision D14). Socket.IO lives only in the API processes, so the worker
// publishes small events on the Redis channel `<redisPrefix>worker-events`; every API instance
// subscribes, re-reads what it needs from the database and emits through the usual realtime
// helpers (ticket:updated with its eviction rules, queue:updated, notification:new). Events carry
// ids only — never ticket content or personal data.

export function workerEventsChannel(redisPrefix: string): string {
  return `${redisPrefix}worker-events`;
}

export const workerEventSchema = z.discriminatedUnion('kind', [
  /** The worker changed a ticket (SLA flags, escalation step, auto-close). */
  z.object({ id: z.uuid(), kind: z.literal('ticket'), ticketId: z.uuid() }),
  /** A new in-app notification for its user. */
  z.object({
    id: z.uuid(),
    kind: z.literal('notification'),
    notificationId: z.uuid(),
    userId: z.uuid(),
  }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export type WorkerEventInput = WorkerEvent extends infer E
  ? E extends { id: string }
    ? Omit<E, 'id'>
    : never
  : never;

export type WorkerEventPublisher = (event: WorkerEventInput) => Promise<void>;

/** Publishes on the channel; failures are logged, never thrown (realtime is best effort). */
export function createWorkerEventPublisher(deps: {
  redis: Redis;
  redisPrefix: string;
  logger: Logger;
}): WorkerEventPublisher {
  const channel = workerEventsChannel(deps.redisPrefix);
  return async (event) => {
    try {
      await deps.redis.publish(channel, JSON.stringify({ ...event, id: randomUUID() }));
    } catch (err) {
      deps.logger.warn({ err, kind: event.kind }, 'could not publish a worker event');
    }
  };
}
