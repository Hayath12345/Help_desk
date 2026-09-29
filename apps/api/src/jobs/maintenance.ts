import type { Prisma } from '@loons/db';
import { UPLOAD_URL_TTL_SECONDS } from '../services/attachments.service.ts';
import { keyHash, queueDeliveries, type PlannedDelivery, type WorkerContext } from './context.ts';
import { digestWindow, hhmmOr } from './local-time.ts';
import { listAddresses } from './recipients.ts';

// The other scheduled `sla` jobs: auto-close (D8), the P4 digest (D9), the orphan-attachment
// sweep (Phase 2 carry-over) and retention (90 days for delivery logs and read notifications).

export interface ScopeOptions {
  now: Date;
  /** Limit to these teams' tickets (tests). */
  teamIds?: readonly string[] | undefined;
}

const DAY_MS = 86_400_000;
const BATCH = 200;

async function setting(ctx: WorkerContext, key: string): Promise<unknown> {
  const row = await ctx.prisma.appSetting.findUnique({ where: { key } });
  return row?.value;
}

// ───────────── Auto-close (D8) ─────────────

export const DEFAULT_AUTO_CLOSE_DAYS = 5;

/** `tickets.autoCloseDays` (a whole number ≥ 1; anything else → 5). */
export async function autoCloseDays(ctx: WorkerContext): Promise<number> {
  const value = await setting(ctx, 'tickets.autoCloseDays');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_AUTO_CLOSE_DAYS;
}

/**
 * SOLVED for `tickets.autoCloseDays` calendar days → CLOSED (closedAt, AUTO_CLOSED event,
 * ticket:updated; no email). The update is conditional on the ticket still being SOLVED since
 * then, so a client reopen that commits first wins (the reopen holds the row lock; this update
 * re-checks after it), and a reopen that comes second finds the ticket CLOSED (409).
 */
export async function runAutoClose(
  ctx: WorkerContext,
  opts: ScopeOptions,
): Promise<{ closed: number }> {
  const days = await autoCloseDays(ctx);
  const cutoff = new Date(opts.now.getTime() - days * DAY_MS);
  const scope: Prisma.TicketWhereInput = opts.teamIds ? { teamId: { in: [...opts.teamIds] } } : {};
  const due = await ctx.prisma.ticket.findMany({
    where: { status: 'SOLVED', solvedAt: { lte: cutoff }, ...scope },
    orderBy: { solvedAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });
  let closed = 0;
  for (const { id } of due) {
    const done = await ctx.prisma.$transaction(async (tx) => {
      const { count } = await tx.ticket.updateMany({
        where: { id, status: 'SOLVED', solvedAt: { lte: cutoff } },
        data: { status: 'CLOSED', closedAt: opts.now, slaAtRiskAt: null },
      });
      if (count === 0) return false;
      await tx.ticketEvent.create({
        data: {
          ticketId: id,
          type: 'AUTO_CLOSED',
          actorId: null,
          fromValue: 'SOLVED',
          toValue: 'CLOSED',
          meta: { days },
          createdAt: opts.now,
        },
      });
      return true;
    });
    if (!done) continue;
    closed += 1;
    await ctx.publish({ kind: 'ticket', ticketId: id });
  }
  return { closed };
}

// ───────────── P4 digest (D9) ─────────────

export const DEFAULT_DIGEST_TIME = '07:30';

export async function digestTime(ctx: WorkerContext): Promise<string> {
  return hhmmOr(await setting(ctx, 'notifications.p4DigestTime'), DEFAULT_DIGEST_TIME);
}

/**
 * One digest per team with P4 tickets created since the previous business day's digest, to the
 * team's distribution list (English, greeting-less). Weekends and holidays have no digest (their
 * tickets go into the next business day's); a team with no new P4 ticket gets nothing.
 */
export async function runDigest(
  ctx: WorkerContext,
  opts: ScopeOptions,
): Promise<{ skipped: string } | { teams: number; deliveries: number }> {
  const calendar = await ctx.ticketConfig.getCalendar();
  const window = digestWindow(opts.now, calendar, await digestTime(ctx));
  if (!window) return { skipped: 'not-a-business-day' };
  const groups = await ctx.prisma.ticket.groupBy({
    by: ['teamId'],
    where: {
      priority: 'P4',
      createdAt: { gte: window.start, lt: window.end },
      ...(opts.teamIds ? { teamId: { in: [...opts.teamIds] } } : {}),
    },
    _count: { _all: true },
  });
  if (groups.length === 0) return { teams: 0, deliveries: 0 };
  const teams = await ctx.prisma.team.findMany({
    where: { id: { in: groups.map((g) => g.teamId) }, isActive: true },
    select: { id: true, emails: true },
  });
  const planned: PlannedDelivery[] = [];
  for (const team of teams) {
    for (const address of listAddresses(team.emails)) {
      planned.push({
        job: {
          dedupeKey: `digest-${team.id}-${window.date}-${keyHash(address)}`,
          channel: 'EMAIL',
          template: 'P4_DAILY_DIGEST',
          teamId: team.id,
          address,
          context: {
            windowStart: window.start.toISOString(),
            windowEnd: window.end.toISOString(),
            digestDate: window.date,
          },
        },
        recipientMasked: address,
      });
    }
  }
  await queueDeliveries(ctx, planned);
  return { teams: teams.length, deliveries: planned.length };
}

// ───────────── Orphan sweep ─────────────

/** Older than the upload POST policy (15 min) plus the confirmation lock, with margin. */
export const ORPHAN_AGE_MS = 30 * 60_000;

/**
 * PENDING / REJECTED attachments older than 30 minutes (never linked to a message): their
 * object (upload key, or a rejected copy) is deleted best effort, then the row. A row whose
 * confirmation is running right now (its Redis lock exists) is left for the next sweep.
 */
export async function runOrphanSweep(
  ctx: WorkerContext,
  opts: ScopeOptions,
): Promise<{ removed: number }> {
  const cutoff = new Date(
    opts.now.getTime() - Math.max(ORPHAN_AGE_MS, UPLOAD_URL_TTL_SECONDS * 2000),
  );
  const rows = await ctx.prisma.attachment.findMany({
    where: {
      status: { in: ['PENDING', 'REJECTED'] },
      messageId: null,
      createdAt: { lt: cutoff },
      ...(opts.teamIds ? { ticket: { teamId: { in: [...opts.teamIds] } } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: { id: true, storageKey: true },
  });
  let removed = 0;
  for (const row of rows) {
    const locked = await ctx.redis.exists(`${ctx.redisPrefix}attachment-confirm:${row.id}`);
    if (locked) continue;
    if (ctx.storage) {
      try {
        await ctx.storage.deleteObject(row.storageKey);
      } catch (err) {
        ctx.logger.warn({ err, attachmentId: row.id }, 'orphan sweep: could not delete an object');
      }
    }
    const { count } = await ctx.prisma.attachment.deleteMany({
      where: { id: row.id, status: { in: ['PENDING', 'REJECTED'] }, messageId: null },
    });
    removed += count;
  }
  return { removed };
}

// ───────────── Retention ─────────────

export const RETENTION_DAYS = 90;

/** Delivery logs and read notifications older than 90 days. */
export async function runRetention(
  ctx: WorkerContext,
  opts: ScopeOptions,
): Promise<{ deliveries: number; notifications: number }> {
  const cutoff = new Date(opts.now.getTime() - RETENTION_DAYS * DAY_MS);
  const [deliveries, notifications] = await Promise.all([
    ctx.prisma.notificationDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        ...(opts.teamIds
          ? {
              OR: [
                { teamId: { in: [...opts.teamIds] } },
                { ticket: { teamId: { in: [...opts.teamIds] } } },
              ],
            }
          : {}),
      },
    }),
    ctx.prisma.notification.deleteMany({
      where: {
        readAt: { lt: cutoff },
        ...(opts.teamIds ? { ticket: { teamId: { in: [...opts.teamIds] } } } : {}),
      },
    }),
  ]);
  return { deliveries: deliveries.count, notifications: notifications.count };
}
