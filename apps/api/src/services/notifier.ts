import type { PrismaClient } from '@loons/db';
import type { Priority } from '@loons/shared';
import {
  MAX_ESCALATION_STEPS,
  MINUTE_MS,
  escalationDelayMs,
  loadP1Chain,
} from '../lib/escalation.ts';
import { escalationJobId, type NotificationEvent } from '../lib/job-data.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppQueues } from '../lib/queues.ts';
import { withTimeout } from '../lib/redis.ts';

// Notification producers of the API (decision D15): called AFTER the database commit, they
// enqueue one event job with a deterministic id (a retry or a double call is a no-op) and, when a
// ticket becomes P1, its first escalation step (D3). Best effort like the realtime emits: a Redis
// failure is logged and never fails the request. Time-based alerts are re-derived by the SLA scan;
// a lost ticket email is not (no outbox in Phase 3).

const ENQUEUE_TIMEOUT_MS = 2_000;

export interface Notifier {
  /** Ticket created (any creator): client acknowledgement, team list, P1 card + chain. */
  ticketCreated(ticket: { id: string; teamId: string; p1Since: Date | null }): Promise<void>;
  /** PATCH priority: becoming P1 starts a period (alert + chain), leaving P1 cancels its chain. */
  priorityChanged(ticket: {
    id: string;
    teamId: string;
    before: { priority: Priority; p1Since: Date | null };
    after: { priority: Priority; p1Since: Date | null };
  }): Promise<void>;
  /** A PUBLIC message: staff → the requester; client → the assignee / team (D6). */
  publicReply(ticketId: string, messageId: string, author: 'staff' | 'client'): Promise<void>;
  /** P1 acknowledged: pending steps cancelled (best effort), in-app to those already paged. */
  acknowledged(ticket: { id: string; p1Since: Date | null; actorId: string }): Promise<void>;
}

export function createNotifier(deps: {
  prisma: PrismaClient;
  queues: AppQueues;
  logger: Logger;
  /** Length of an escalation "minute" (tests shrink it). */
  minuteMs?: number;
}): Notifier {
  const { prisma, queues, logger } = deps;
  const minuteMs = deps.minuteMs ?? MINUTE_MS;

  async function attempt(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await withTimeout(fn(), ENQUEUE_TIMEOUT_MS, what);
    } catch (err) {
      logger.error({ err, job: what }, 'could not enqueue a notification job');
    }
  }

  const event = (e: NotificationEvent) => attempt(e.event, () => queues.enqueueEvent(e));

  /** Schedules the first step of the chain in force (D3; later steps are chained by the worker). */
  async function startChain(ticketId: string, teamId: string, p1Since: Date): Promise<void> {
    await attempt('p1-escalation', async () => {
      const [first] = await loadP1Chain(prisma, teamId);
      if (!first) {
        logger.warn({ ticketId }, 'no active P1 escalation rule: nobody will be paged');
        return;
      }
      await queues.scheduleEscalation(
        { ticketId, p1Since: p1Since.toISOString(), step: first.step },
        escalationDelayMs(p1Since, first.afterMins, new Date(), minuteMs),
      );
    });
  }

  /** Removes the period's pending step jobs (the worker also re-checks when a step fires). */
  async function cancelChain(ticketId: string, p1Since: Date): Promise<void> {
    await attempt('p1-escalation-cancel', () =>
      queues.removeJobs(
        'escalation',
        Array.from({ length: MAX_ESCALATION_STEPS }, (_, i) =>
          escalationJobId(ticketId, p1Since, i + 1),
        ),
      ),
    );
  }

  return {
    async ticketCreated(ticket) {
      await event({ event: 'ticket-created', ticketId: ticket.id });
      if (ticket.p1Since) await startChain(ticket.id, ticket.teamId, ticket.p1Since);
    },

    async priorityChanged({ id, teamId, before, after }) {
      const wasP1 = before.priority === 'P1';
      const isP1 = after.priority === 'P1';
      if (wasP1 === isP1) return;
      if (wasP1 && before.p1Since) await cancelChain(id, before.p1Since);
      if (isP1 && after.p1Since) {
        await event({ event: 'p1-started', ticketId: id, p1Since: after.p1Since.toISOString() });
        await startChain(id, teamId, after.p1Since);
      }
    },

    async publicReply(ticketId, messageId, author) {
      await event({
        event: author === 'staff' ? 'agent-reply' : 'client-reply',
        ticketId,
        messageId,
      });
    },

    async acknowledged({ id, p1Since, actorId }) {
      if (!p1Since) return;
      await cancelChain(id, p1Since);
      await event({
        event: 'p1-acknowledged',
        ticketId: id,
        p1Since: p1Since.toISOString(),
        actorId,
      });
    },
  };
}

/** A notifier that does nothing (services used outside the HTTP server). */
export const noopNotifier: Notifier = {
  ticketCreated: async () => undefined,
  priorityChanged: async () => undefined,
  publicReply: async () => undefined,
  acknowledged: async () => undefined,
};
