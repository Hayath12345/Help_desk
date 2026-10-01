import type { PrismaClient } from '@loons/db';
import {
  REPORT_PERIOD_DAYS,
  slaMinutesBetween,
  type Actor,
  type ReportsSummary,
  type ReportsSummaryQuery,
} from '@loons/shared';
import { addDays, localDate, zonedInstant } from '../jobs/local-time.ts';
import { requireStaff } from './ticket-access.ts';
import type { TicketConfigService } from './ticket-config.service.ts';
import { CATEGORY_ADMIN_ORDER, categoryRefSelect } from './ticket-dto.ts';
import { ACTIVE_SQL, DONE_SQL, breachedSql, sqlTimestamp, visibleSql } from './ticket-query.ts';

// Phase 5 Reports (decisions F10–F12), one round trip for the page. Staff only; every number is
// scoped like the Inbox (the visibility SQL of ticket-query.ts), so a viewer never counts a
// ticket they can't open.
//
// - Snapshot tiles (now): open, P1 open, SLA breached (`breachedSql`, twin of `hasBreachedSla`),
//   unassigned.
// - Period tiles: the last N days in `business.timezone` (today included, from local midnight):
//   tickets solved in the period (and still solved / closed), and the average first reply time on
//   the SLA clock — business minutes for business-hours policies, calendar minutes otherwise — as
//   stored on the FIRST_REPLY event when the reply was sent (the priority and calendar in force
//   then); replies from before Phase 5 are measured with the current calendar and policies.
// - Open tickets by category: every active category in admin order (zeros included), then the
//   archived ones that still have open tickets.

export interface ReportsService {
  summary(actor: Actor, query: ReportsSummaryQuery): Promise<ReportsSummary>;
}

/** Start of a period of `days` local days ending today (local midnight, `timeZone`). */
export function periodStart(now: Date, days: number, timeZone: string): Date {
  return zonedInstant(addDays(localDate(now, timeZone), -(days - 1)), '00:00', timeZone);
}

export function createReportsService(deps: {
  prisma: PrismaClient;
  ticketConfig: TicketConfigService;
  /** Clock (tests). */
  now?: () => Date;
}): ReportsService {
  const { prisma, ticketConfig } = deps;
  const clock = deps.now ?? (() => new Date());

  return {
    async summary(actor, query) {
      requireStaff(actor);
      const now = clock();
      const [calendar, config] = await Promise.all([
        ticketConfig.getCalendar(),
        ticketConfig.getFormConfig(),
      ]);
      const from = periodStart(now, REPORT_PERIOD_DAYS[query.period], calendar.timeZone);
      const visible = visibleSql(actor);
      const fromTs = sqlTimestamp(from);

      const [tileRows, replied, openByCategory] = await Promise.all([
        prisma.$queryRaw<
          Array<{
            open: number;
            p1Open: number;
            breached: number;
            unassigned: number;
            solved: number;
          }>
        >`
          SELECT count(*) FILTER (WHERE ${ACTIVE_SQL})::int AS open,
            count(*) FILTER (WHERE ${ACTIVE_SQL} AND t."priority" = 'P1'::"Priority")::int AS "p1Open",
            count(*) FILTER (WHERE ${breachedSql(now)})::int AS breached,
            count(*) FILTER (WHERE ${ACTIVE_SQL} AND t."assigneeId" IS NULL)::int AS unassigned,
            count(*) FILTER (WHERE ${DONE_SQL} AND t."solvedAt" >= ${fromTs})::int AS solved
          FROM "Ticket" t
          WHERE ${visible}`,
        prisma.$queryRaw<
          Array<{
            priority: string;
            createdAt: Date;
            firstRepliedAt: Date;
            slaMinutes: string | null;
          }>
        >`
          SELECT t."priority"::text AS priority, t."createdAt" AS "createdAt",
            t."firstRepliedAt" AS "firstRepliedAt",
            (SELECT e."meta"->>'slaMinutesToFirstReply' FROM "TicketEvent" e
              WHERE e."ticketId" = t."id" AND e."type" = 'FIRST_REPLY'::"TicketEventType"
              ORDER BY e."createdAt" ASC, e."id" ASC LIMIT 1) AS "slaMinutes"
          FROM "Ticket" t
          WHERE ${visible} AND t."firstRepliedAt" >= ${fromTs}`,
        prisma.$queryRaw<Array<{ categoryId: string; open: number }>>`
          SELECT t."categoryId" AS "categoryId", count(*)::int AS open
          FROM "Ticket" t
          WHERE ${visible} AND ${ACTIVE_SQL}
          GROUP BY t."categoryId"`,
      ]);
      const tiles = tileRows[0] ?? { open: 0, p1Open: 0, breached: 0, unassigned: 0, solved: 0 };

      // Average first reply on the SLA clock (F11).
      const businessHours = new Map(
        config.slaPolicies.map((p) => [p.priority as string, p.businessHoursOnly]),
      );
      let totalMinutes = 0;
      for (const t of replied) {
        const stored = t.slaMinutes === null ? Number.NaN : Number(t.slaMinutes);
        totalMinutes +=
          Number.isSafeInteger(stored) && stored >= 0
            ? stored
            : slaMinutesBetween(
                t.createdAt,
                t.firstRepliedAt,
                calendar,
                businessHours.get(t.priority) ?? false,
              );
      }

      // Open tickets by category (F12).
      const counts = new Map(openByCategory.map((r) => [r.categoryId, r.open]));
      const [active, archived] = await Promise.all([
        prisma.category.findMany({
          where: { isActive: true },
          orderBy: [...CATEGORY_ADMIN_ORDER],
          select: categoryRefSelect,
        }),
        prisma.category.findMany({
          where: { isActive: false, id: { in: [...counts.keys()] } },
          orderBy: [...CATEGORY_ADMIN_ORDER],
          select: categoryRefSelect,
        }),
      ]);

      return {
        period: query.period,
        timeZone: calendar.timeZone,
        from: from.toISOString(),
        generatedAt: now.toISOString(),
        tiles: {
          open: tiles.open,
          p1Open: tiles.p1Open,
          breached: tiles.breached,
          unassigned: tiles.unassigned,
          solved: tiles.solved,
          firstReply: {
            averageMinutes: replied.length ? Math.round(totalMinutes / replied.length) : null,
            tickets: replied.length,
          },
        },
        byCategory: [...active, ...archived].map((category) => ({
          category,
          open: counts.get(category.id) ?? 0,
        })),
      };
    },
  };
}
