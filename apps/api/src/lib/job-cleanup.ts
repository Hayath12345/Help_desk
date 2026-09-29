import { Queue, type ConnectionOptions } from 'bullmq';

// Removes the queued / delayed jobs of tickets that are about to be deleted (the Playwright
// teardown, packages/db/scripts/cleanup-e2e.ts), so no notification or escalation step of a
// removed ticket fires later. The processors already treat a missing ticket as a no-op; this
// keeps the queues clean too. Self-contained (bullmq only) so the db package can load it.

/** Queues whose jobs carry `data.ticketId`. */
export const TICKET_JOB_QUEUES = ['notifications', 'escalation'] as const;
const PENDING_STATES = ['waiting', 'delayed', 'prioritized', 'waiting-children'] as const;

export async function removeTicketJobs(options: {
  connection: ConnectionOptions;
  /** BullMQ prefix (`<redisPrefix>bull`, "loons:bull" by default). */
  prefix: string;
  ticketIds: readonly string[];
}): Promise<number> {
  const ids = new Set(options.ticketIds);
  if (ids.size === 0) return 0;
  let removed = 0;
  for (const name of TICKET_JOB_QUEUES) {
    const queue = new Queue(name, { connection: options.connection, prefix: options.prefix });
    queue.on('error', () => undefined);
    try {
      const jobs = await queue.getJobs([...PENDING_STATES]);
      for (const job of jobs) {
        const ticketId = (job?.data as { ticketId?: unknown } | undefined)?.ticketId;
        if (typeof ticketId !== 'string' || !ids.has(ticketId)) continue;
        try {
          await job.remove();
          removed += 1;
        } catch {
          // Started meanwhile: the processor finds the ticket gone and does nothing.
        }
      }
    } finally {
      await queue.close();
    }
  }
  return removed;
}
