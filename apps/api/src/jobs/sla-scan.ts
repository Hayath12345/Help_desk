import { Prisma } from '@loons/db';
import {
  ACTIVE_STATUSES,
  computeSlaTargets,
  type SlaSignalKind,
  type SlaTarget,
} from '@loons/shared';
import { ACTIVE_SQL, atRiskSql, sqlTimestamp } from '../services/ticket-query.ts';
import { slaPausesOf } from '../services/ticket-state.ts';
import type { WorkerContext } from './context.ts';
import { resumeStalledEscalations } from './escalation.ts';
import { digestTime } from './maintenance.ts';
import { rescheduleForSettings } from './schedulers.ts';

// The SLA scan (spec §7, decisions D1 / D2 / D10), every minute:
//
// 1. Backfill: active tickets from before Phase 3 get their at-risk instants (computed like the
//    API does, never later than the due date).
// 2. Crossings: for each running target — first reply while unanswered (also while PENDING: that
//    pause only stops the resolution clock), resolution while not PENDING — an at-risk instant
//    or a due date that has passed is a crossing. A `TicketSlaSignal` row is inserted first
//    (unique per ticket × target × kind × due date: a moved due date is a new signal); only the
//    worker whose insert went in writes the TicketEvent, sets the summary flags and — for
//    crossings of the last 60 minutes only (D10) — marks the signal `notify`. Older crossings
//    (a worker that was down, tickets from before Phase 3) are flagged silently. A crossing that
//    a priority change put in the past counts as fresh from the change (`slaTargetsChangedAt`).
// 3. Announcements: every `notify` signal not yet enqueued and at most 60 minutes old is
//    enqueued (deterministic job id) and marked `enqueuedAt`, so an enqueue that failed after the
//    commit (Redis down, worker killed) is retried by the next scans instead of being lost.
// 5. Escalation safety net: see `resumeStalledEscalations` (jobs/escalation.ts); it also fires a
//    pending step whose delay an admin shortened (E13).
// 6. Settings (E11): the business time zone and the P4 digest time are re-read, and the daily
//    schedulers that follow them are rewritten when they changed (`rescheduleForSettings`), so an
//    admin change applies within a minute without restarting the worker.
// 4. Summary flag: `slaAtRiskAt` follows the live rule (`atRiskSql`, the same predicate as the
//    risk view): cleared when no target is at risk any more, set when one is. `slaBreached` stays
//    (reporting).

/** D10: only crossings this recent notify anyone. */
export const SLA_NOTIFY_WINDOW_MS = 60 * 60_000;
const DEFAULT_BATCH = 200;

const sql = Prisma.sql;

export interface SlaScanOptions {
  now: Date;
  /** Limit to these teams' tickets (tests). */
  teamIds?: readonly string[] | undefined;
  batch?: number;
}

export interface SlaScanResult {
  backfilled: number;
  /** Signals this scan inserted. */
  signals: number;
  /** Announcements enqueued by this scan (fresh signals, incl. retries of earlier ones). */
  notified: number;
  /** Overdue P1 escalation steps without a live job, re-scheduled by the safety net. */
  escalationsResumed: number;
  /** Schedulers rewritten because the time zone or digest time changed (E11). */
  schedulersRescheduled: string[];
}

interface Crossing {
  target: SlaTarget;
  kind: SlaSignalKind;
  dueAt: Date;
  /** When the threshold was crossed (at-risk instant or due date). */
  at: Date;
}

/**
 * D10: whether a crossing is fresh enough to announce — crossed (or, after a priority change,
 * re-targeted) at most 60 minutes ago.
 */
export function isFreshCrossing(at: Date, targetsChangedAt: Date | null, now: Date): boolean {
  const from = targetsChangedAt && targetsChangedAt > at ? targetsChangedAt : at;
  return now.getTime() - from.getTime() <= SLA_NOTIFY_WINDOW_MS;
}

function scopeSql(teamIds: readonly string[] | undefined) {
  return teamIds ? sql`AND t."teamId" = ANY(${[...teamIds]}::uuid[])` : Prisma.empty;
}

function signalMissing(target: SlaTarget, kind: SlaSignalKind, due: Prisma.Sql) {
  return sql`NOT EXISTS (SELECT 1 FROM "TicketSlaSignal" s WHERE s."ticketId" = t."id"
    AND s."target" = ${target}::"SlaTarget" AND s."kind" = ${kind}::"SlaSignalKind"
    AND s."dueAt" = ${due})`;
}

/** 1. At-risk instants for tickets that have due dates but none yet. */
async function backfill(ctx: WorkerContext, opts: SlaScanOptions): Promise<number> {
  const rows = await ctx.prisma.ticket.findMany({
    where: {
      status: { in: [...ACTIVE_STATUSES] },
      ...(opts.teamIds ? { teamId: { in: [...opts.teamIds] } } : {}),
      OR: [
        { firstReplyAtRiskAt: null, firstReplyDueAt: { not: null } },
        { resolveAtRiskAt: null, resolveDueAt: { not: null } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: opts.batch ?? DEFAULT_BATCH,
    select: {
      id: true,
      priority: true,
      createdAt: true,
      firstReplyDueAt: true,
      resolveDueAt: true,
      firstReplyAtRiskAt: true,
      resolveAtRiskAt: true,
      slaPauses: true,
    },
  });
  if (rows.length === 0) return 0;
  const [config, calendar] = await Promise.all([
    ctx.ticketConfig.getFormConfig(),
    ctx.ticketConfig.getCalendar(),
  ]);
  let updated = 0;
  for (const t of rows) {
    const policy = config.slaPolicies.find((p) => p.priority === t.priority);
    if (!policy) continue;
    let targets;
    try {
      targets = computeSlaTargets(t.createdAt, policy, calendar, slaPausesOf(t.slaPauses));
    } catch (err) {
      ctx.logger.warn({ err, ticketId: t.id }, 'could not compute the at-risk instants');
      continue;
    }
    // Never after the stored due date (seeded / older due dates may be calendar approximations).
    const clamp = (instant: Date, due: Date) => (instant > due ? due : instant);
    // Raw updates: SLA bookkeeping is not a change of the ticket (`updatedAt` and the "recent"
    // sort stay put).
    if (t.firstReplyDueAt && !t.firstReplyAtRiskAt) {
      const at = clamp(targets.firstReplyAtRiskAt, t.firstReplyDueAt);
      updated += await ctx.prisma
        .$executeRaw(sql`UPDATE "Ticket" SET "firstReplyAtRiskAt" = ${sqlTimestamp(at)}
        WHERE "id" = ${t.id}::uuid AND "firstReplyAtRiskAt" IS NULL`);
    }
    if (t.resolveDueAt && !t.resolveAtRiskAt) {
      const at = clamp(targets.resolveAtRiskAt, t.resolveDueAt);
      updated += await ctx.prisma
        .$executeRaw(sql`UPDATE "Ticket" SET "resolveAtRiskAt" = ${sqlTimestamp(at)}
        WHERE "id" = ${t.id}::uuid AND "resolveAtRiskAt" IS NULL`);
    }
  }
  return updated;
}

/** Ids of active tickets with a crossing that has no signal yet. */
async function candidates(ctx: WorkerContext, opts: SlaScanOptions): Promise<string[]> {
  const now = sqlTimestamp(opts.now);
  const frRunning = sql`(t."firstRepliedAt" IS NULL AND t."firstReplyDueAt" IS NOT NULL)`;
  const resRunning = sql`(t."status" <> 'PENDING'::"TicketStatus" AND t."resolveDueAt" IS NOT NULL)`;
  const fr = sql`t."firstReplyDueAt"`;
  const res = sql`t."resolveDueAt"`;
  // Newest crossing (or re-targeting) first: a large backlog of old, silent crossings (first
  // deploy on a busy queue) must not hold a fresh one back past the D10 window.
  const passed = (col: string) =>
    sql`CASE WHEN t.${Prisma.raw(`"${col}"`)} <= ${now} THEN t.${Prisma.raw(`"${col}"`)} END`;
  const latestPassed = sql`GREATEST(${passed('firstReplyAtRiskAt')}, ${passed('firstReplyDueAt')},
    ${passed('resolveAtRiskAt')}, ${passed('resolveDueAt')}, ${passed('slaTargetsChangedAt')})`;
  const rows = await ctx.prisma.$queryRaw<Array<{ id: string }>>(sql`
    SELECT t."id" FROM "Ticket" t
    WHERE ${ACTIVE_SQL} ${scopeSql(opts.teamIds)}
      AND (
        (${frRunning} AND (
          (t."firstReplyAtRiskAt" <= ${now} AND ${signalMissing('FIRST_REPLY', 'AT_RISK', fr)})
          OR (${fr} < ${now} AND ${signalMissing('FIRST_REPLY', 'BREACHED', fr)})
        ))
        OR (${resRunning} AND (
          (t."resolveAtRiskAt" <= ${now} AND ${signalMissing('RESOLUTION', 'AT_RISK', res)})
          OR (${res} < ${now} AND ${signalMissing('RESOLUTION', 'BREACHED', res)})
        ))
      )
    ORDER BY ${latestPassed} DESC NULLS LAST, t."createdAt" ASC
    LIMIT ${opts.batch ?? DEFAULT_BATCH}`);
  return rows.map((r) => r.id);
}

/** The crossings of one ticket at `now` (running targets only). */
export function crossingsOf(
  t: {
    status: string;
    firstRepliedAt: Date | null;
    firstReplyDueAt: Date | null;
    firstReplyAtRiskAt: Date | null;
    resolveDueAt: Date | null;
    resolveAtRiskAt: Date | null;
  },
  now: Date,
): Crossing[] {
  const out: Crossing[] = [];
  const check = (target: SlaTarget, due: Date | null, atRisk: Date | null) => {
    if (!due) return;
    if (atRisk && atRisk <= now) out.push({ target, kind: 'AT_RISK', dueAt: due, at: atRisk });
    if (due < now) out.push({ target, kind: 'BREACHED', dueAt: due, at: due });
  };
  if (!(ACTIVE_STATUSES as readonly string[]).includes(t.status)) return out;
  if (!t.firstRepliedAt) check('FIRST_REPLY', t.firstReplyDueAt, t.firstReplyAtRiskAt);
  if (t.status !== 'PENDING') check('RESOLUTION', t.resolveDueAt, t.resolveAtRiskAt);
  return out;
}

/** Records one ticket's new crossings; returns the ones this worker inserted. */
async function recordCrossings(
  ctx: WorkerContext,
  ticketId: string,
  now: Date,
): Promise<Crossing[]> {
  return ctx.prisma.$transaction(async (tx) => {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      select: {
        status: true,
        firstRepliedAt: true,
        firstReplyDueAt: true,
        firstReplyAtRiskAt: true,
        resolveDueAt: true,
        resolveAtRiskAt: true,
        slaTargetsChangedAt: true,
      },
    });
    if (!t) return [];
    const inserted: Crossing[] = [];
    for (const c of crossingsOf(t, now)) {
      // The unique index decides who records the crossing (a concurrent insert waits for us).
      const { count } = await tx.ticketSlaSignal.createMany({
        data: [{ ticketId, target: c.target, kind: c.kind, dueAt: c.dueAt, createdAt: now }],
        skipDuplicates: true,
      });
      if (count === 0) continue;
      inserted.push(c);
      const type = c.kind === 'AT_RISK' ? 'SLA_AT_RISK' : 'SLA_BREACHED';
      const dueIso = c.dueAt.toISOString();
      // Seeded tickets already carry the events a worker "would have" raised: no duplicates.
      const existing = await tx.ticketEvent.findFirst({
        where: {
          ticketId,
          type,
          AND: [
            { meta: { path: ['target'], equals: c.target } },
            { meta: { path: ['dueAt'], equals: dueIso } },
          ],
        },
        select: { id: true },
      });
      if (!existing) {
        await tx.ticketEvent.create({
          data: {
            ticketId,
            type,
            actorId: null,
            fromValue: null,
            toValue: null,
            meta: { target: c.target, dueAt: dueIso },
            createdAt: c.at,
          },
        });
      }
      // Summary flags (raw: `updatedAt` stays, see backfill). Breached is sticky.
      const breached = c.kind === 'BREACHED';
      await tx.$executeRaw(sql`UPDATE "Ticket" SET
          "slaAtRiskAt" = COALESCE("slaAtRiskAt", ${sqlTimestamp(c.at)}),
          "slaBreached" = "slaBreached" OR ${breached},
          "slaBreachedAt" = CASE WHEN ${breached} THEN COALESCE("slaBreachedAt", ${sqlTimestamp(c.dueAt)})
            ELSE "slaBreachedAt" END
        WHERE "id" = ${ticketId}::uuid`);
    }
    // Which of them are announced (D10), decided with the insert so a later scan can finish the
    // job: fresh crossings only, and when both thresholds of one target cross at once (e.g. after
    // a pause) only the breach.
    for (const c of inserted) {
      if (!isFreshCrossing(c.at, t.slaTargetsChangedAt, now)) continue;
      if (
        c.kind === 'AT_RISK' &&
        inserted.some((o) => o.kind === 'BREACHED' && o.target === c.target)
      ) {
        continue;
      }
      await tx.ticketSlaSignal.updateMany({
        where: { ticketId, target: c.target, kind: c.kind, dueAt: c.dueAt },
        data: { notify: true },
      });
    }
    return inserted;
  });
}

/**
 * 3. Enqueues the announcements of fresh signals not enqueued yet (this scan's, or an earlier
 * scan's whose enqueue failed). Resolves to how many were enqueued; a failure is logged and left
 * for the next scan (at most 60 minutes after the signal).
 */
async function announce(ctx: WorkerContext, opts: SlaScanOptions): Promise<number> {
  const pending = await ctx.prisma.ticketSlaSignal.findMany({
    where: {
      notify: true,
      enqueuedAt: null,
      createdAt: { gte: new Date(opts.now.getTime() - SLA_NOTIFY_WINDOW_MS) },
      ...(opts.teamIds ? { ticket: { teamId: { in: [...opts.teamIds] } } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: opts.batch ?? DEFAULT_BATCH,
    select: { id: true, ticketId: true, target: true, kind: true, dueAt: true },
  });
  let enqueued = 0;
  for (const s of pending) {
    try {
      await ctx.queues.enqueueEvent({
        event: 'sla',
        ticketId: s.ticketId,
        target: s.target,
        kind: s.kind,
        dueAt: s.dueAt.toISOString(),
      });
    } catch (err) {
      ctx.logger.warn(
        { err, ticketId: s.ticketId },
        'could not enqueue an SLA notification; the next scan retries',
      );
      continue;
    }
    await ctx.prisma.ticketSlaSignal.updateMany({
      where: { id: s.id, enqueuedAt: null },
      data: { enqueuedAt: opts.now },
    });
    enqueued += 1;
  }
  return enqueued;
}

/** 4. `slaAtRiskAt` = "a running target is at risk or overdue now" (no event, no notification). */
async function reconcileFlags(ctx: WorkerContext, opts: SlaScanOptions): Promise<void> {
  const scope = scopeSql(opts.teamIds);
  await ctx.prisma.$executeRaw(sql`UPDATE "Ticket" AS t SET "slaAtRiskAt" = NULL
    WHERE t."slaAtRiskAt" IS NOT NULL AND NOT ${atRiskSql(opts.now)} ${scope}`);
  await ctx.prisma
    .$executeRaw(sql`UPDATE "Ticket" AS t SET "slaAtRiskAt" = ${sqlTimestamp(opts.now)}
    WHERE t."slaAtRiskAt" IS NULL AND ${atRiskSql(opts.now)} ${scope}`);
}

export async function runSlaScan(ctx: WorkerContext, opts: SlaScanOptions): Promise<SlaScanResult> {
  const { now } = opts;
  const backfilled = await backfill(ctx, opts);
  let signals = 0;
  for (const ticketId of await candidates(ctx, opts)) {
    const inserted = await recordCrossings(ctx, ticketId, now);
    if (inserted.length === 0) continue;
    signals += inserted.length;
    await ctx.publish({ kind: 'ticket', ticketId });
  }
  const notified = await announce(ctx, opts);
  await reconcileFlags(ctx, opts);
  // 5. P1 chains whose next step is overdue with no live job (see resumeStalledEscalations).
  const escalationsResumed = await resumeStalledEscalations(ctx, opts);
  // 6. The daily schedulers follow the General settings.
  const schedulersRescheduled = await syncSchedulerSettings(ctx);
  return { backfilled, signals, notified, escalationsResumed, schedulersRescheduled };
}

/**
 * Re-reads `business.timezone` (the cached calendar, dropped by every admin change) and
 * `notifications.p4DigestTime`, and rewrites the schedulers that follow them when they differ.
 * Never fails the scan: an error is logged and the next tick tries again.
 */
export async function syncSchedulerSettings(ctx: WorkerContext): Promise<string[]> {
  try {
    const [calendar, time] = await Promise.all([ctx.ticketConfig.getCalendar(), digestTime(ctx)]);
    const changed = await rescheduleForSettings(ctx.queues.sla, {
      timeZone: calendar.timeZone,
      digestTime: time,
    });
    if (changed.length) {
      ctx.logger.info(
        { schedulers: changed, timeZone: calendar.timeZone, digestTime: time },
        'schedulers rescheduled after a settings change',
      );
    }
    return changed;
  } catch (err) {
    ctx.logger.warn({ err }, 'could not re-check the scheduler settings');
    return [];
  }
}
