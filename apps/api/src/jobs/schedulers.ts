import type { Job, Queue, RepeatOptions } from 'bullmq';
import { SLA_JOBS, type SlaJob } from '../lib/job-data.ts';
import type { SlaJobData } from '../lib/queues.ts';

// The repeatable `sla` jobs (contract "Worker"). bullmq 6 rejects `repeat` on Queue.add, so they
// are job schedulers: fixed ids, so every worker that starts upserts the same five (never
// duplicates), and one job per tick whichever worker takes it. A worker started with
// WORKER_SCHEDULERS=false only consumes. Each tick is its own attempt (the next tick retries).
//
// A scheduler that already exists with the same timing and data is left as it is: upserting it
// again replaces a tick that came due while no worker was running (a restart or deploy at 07:30)
// with the next occurrence, and that day's P4 digest would never be sent. Left alone, the overdue
// tick runs as soon as a worker consumes, and the digest works out its window from the time the
// tick was due (`scheduledTickTime`), not from when it finally ran.

export const SCHEDULER_INTERVALS = {
  slaScanMs: 60_000,
  autoCloseMs: 15 * 60_000,
  orphanSweepMs: 30 * 60_000,
} as const;

/** Daily retention at 03:17 local time. */
export const RETENTION_PATTERN = '17 3 * * *';

/** "07:30" → the cron pattern "30 7 * * *". */
export function dailyPattern(hhmm: string): string {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return `${mm} ${hh} * * *`;
}

export interface SchedulerOptions {
  /** Business time zone (AppSetting `business.timezone`). */
  timeZone: string;
  /** Local time of the P4 digest (AppSetting `notifications.p4DigestTime`). */
  digestTime: string;
  /** Data for every scheduled job (tests scope them to their fixtures). */
  data?: SlaJob;
}

const TEMPLATE_OPTS = {
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const;

type SchedulerRepeat = Pick<RepeatOptions, 'every' | 'pattern' | 'tz'>;

/**
 * Upserts one scheduler unless it already exists with the same timing and data. Resolves to
 * whether it was (re)written.
 */
export async function upsertSchedulerIfChanged(
  queue: Queue<SlaJobData>,
  id: string,
  repeat: SchedulerRepeat,
  data: SlaJob,
): Promise<boolean> {
  const existing = await queue.getJobScheduler(id);
  if (
    existing &&
    (existing.every === undefined ? undefined : Number(existing.every)) === repeat.every &&
    (existing.pattern ?? undefined) === repeat.pattern &&
    (existing.tz ?? undefined) === repeat.tz &&
    JSON.stringify(existing.template?.data ?? {}) === JSON.stringify(data)
  ) {
    return false;
  }
  await queue.upsertJobScheduler(id, repeat, { name: id, data, opts: TEMPLATE_OPTS });
  return true;
}

/**
 * When a scheduler's tick was due (its delayed job's timestamp + delay), else `fallback`. A tick
 * that ran late — no worker was up at 07:30 — still covers its own digest window.
 */
export function scheduledTickTime(
  job: Pick<Job, 'timestamp' | 'opts' | 'repeatJobKey'>,
  fallback: Date,
): Date {
  if (!job.repeatJobKey || job.opts.delay === undefined) return fallback;
  const due = job.timestamp + job.opts.delay;
  return Number.isFinite(due) && due <= fallback.getTime() ? new Date(due) : fallback;
}

/** Upserts the five schedulers (unchanged ones are left alone); resolves to their ids. */
export async function registerSchedulers(
  queue: Queue<SlaJobData>,
  options: SchedulerOptions,
): Promise<string[]> {
  const data = options.data ?? {};
  const tz = options.timeZone;
  const specs = [
    { id: SLA_JOBS.scan, repeat: { every: SCHEDULER_INTERVALS.slaScanMs } },
    { id: SLA_JOBS.autoClose, repeat: { every: SCHEDULER_INTERVALS.autoCloseMs } },
    { id: SLA_JOBS.digest, repeat: { pattern: dailyPattern(options.digestTime), tz } },
    { id: SLA_JOBS.orphanSweep, repeat: { every: SCHEDULER_INTERVALS.orphanSweepMs } },
    { id: SLA_JOBS.retention, repeat: { pattern: RETENTION_PATTERN, tz } },
  ];
  for (const spec of specs) {
    await upsertSchedulerIfChanged(queue, spec.id, spec.repeat, data);
  }
  return specs.map((s) => s.id);
}
