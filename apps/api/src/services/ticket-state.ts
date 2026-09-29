import type { Prisma } from '@loons/db';
import type { BusinessCalendar, SlaPause, TicketStatus } from '@loons/shared';
import type { SlaMath } from './sla.ts';

// Side effects of a status change on the SLA clocks (spec §7): SOLVED stamps `solvedAt`
// (reopening clears it); entering PENDING pauses the resolution clock (`slaPausedAt`), leaving it
// resumes the clock with the SLA time that was left (`resumeDueDate`) and records the finished
// pause in `slaPauses`, so a later priority change can recompute the target with the same credit.
// The first-reply clock is never paused.

export interface StatusChangeContext {
  from: TicketStatus;
  to: TicketStatus;
  now: Date;
  /** The resolution due date in force (after any priority change in the same update). */
  resolveDueAt: Date | null;
  slaPausedAt: Date | null;
  /** The ticket's finished pauses (`Ticket.slaPauses`). */
  slaPauses: Prisma.JsonValue;
  businessHoursOnly: boolean;
  calendar: () => Promise<BusinessCalendar>;
  math: SlaMath;
}

export type StatusChangeData = Pick<
  Prisma.TicketUncheckedUpdateInput,
  'status' | 'solvedAt' | 'slaPausedAt' | 'resolveDueAt' | 'slaPauses'
>;

/** Stored form of one finished pause. */
interface StoredPause {
  from: string;
  to: string;
}

function isStoredPause(value: unknown): value is StoredPause {
  if (value === null || typeof value !== 'object') return false;
  const { from, to } = value as Record<string, unknown>;
  return (
    typeof from === 'string' &&
    typeof to === 'string' &&
    !Number.isNaN(Date.parse(from)) &&
    !Number.isNaN(Date.parse(to))
  );
}

function storedPauses(value: Prisma.JsonValue): StoredPause[] {
  return Array.isArray(value) ? value.flatMap((v) => (isStoredPause(v) ? [v] : [])) : [];
}

/** `Ticket.slaPauses` as SLA pauses (malformed entries are skipped). */
export function slaPausesOf(value: Prisma.JsonValue): SlaPause[] {
  return storedPauses(value).map((p) => ({ from: new Date(p.from), to: new Date(p.to) }));
}

/** `slaPauses` with one more finished pause appended. */
export function withPause(value: Prisma.JsonValue, from: Date, to: Date): Prisma.InputJsonArray {
  return [
    ...storedPauses(value).map((p) => ({ from: p.from, to: p.to })),
    { from: from.toISOString(), to: to.toISOString() },
  ];
}

export async function statusChangeData(ctx: StatusChangeContext): Promise<StatusChangeData> {
  const { from, to, now } = ctx;
  const data: StatusChangeData = { status: to };
  if (to === 'SOLVED') data.solvedAt = now;
  else if (from === 'SOLVED') data.solvedAt = null;

  if (to === 'PENDING' && from !== 'PENDING') {
    data.slaPausedAt = now;
  } else if (from === 'PENDING' && to !== 'PENDING') {
    data.slaPausedAt = null;
    if (ctx.slaPausedAt) {
      data.slaPauses = withPause(ctx.slaPauses, ctx.slaPausedAt, now);
      if (ctx.resolveDueAt) {
        data.resolveDueAt = ctx.math.resumeDueDate(
          ctx.resolveDueAt,
          ctx.slaPausedAt,
          now,
          await ctx.calendar(),
          ctx.businessHoursOnly,
        );
      }
    }
  }
  return data;
}
