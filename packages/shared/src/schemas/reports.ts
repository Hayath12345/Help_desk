// Phase 5 — Reports (decisions F10–F12). Staff only (clients get 403); every number counts only the
// tickets the caller can see (the Inbox visibility).
//
// GET /reports/summary?period=7d|30d|90d → ReportsSummary (tiles + open tickets by category)

import { z } from 'zod';
import { categoryRefSchema } from './tickets.ts';

const isoDate = z.iso.datetime({ offset: true });

/** Period picker: the last 7, 30 (default) or 90 days, today included. */
export const REPORT_PERIODS = ['7d', '30d', '90d'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];
export const DEFAULT_REPORT_PERIOD: ReportPeriod = '30d';
export const REPORT_PERIOD_DAYS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
} as const satisfies Record<ReportPeriod, number>;

export const reportsSummaryQuerySchema = z.object({
  period: z.enum(REPORT_PERIODS).optional().default(DEFAULT_REPORT_PERIOD),
});
export type ReportsSummaryQuery = z.infer<typeof reportsSummaryQuerySchema>;

/**
 * Average first reply (F11): from creation to the first public staff reply, for tickets first
 * replied in the period, measured on the SLA clock — calendar time for 24/7 policies (P1 / P2),
 * business hours (holidays excluded) for business-hours policies (P3 / P4) — so it compares with
 * the SLA targets. Each ticket counts in whole minutes (rounded down); `averageMinutes` is their
 * mean rounded to the nearest minute, null when no ticket was first replied in the period.
 */
export const firstReplyTileSchema = z.object({
  averageMinutes: z.number().int().nonnegative().nullable(),
  /** Tickets behind the average (the tile's subtitle). */
  tickets: z.number().int().nonnegative(),
});

export const reportCategoryRowSchema = z.object({
  /** `isActive` false: an archived category that still has open tickets. */
  category: categoryRefSchema,
  /** Open (NEW / OPEN / PENDING) tickets in the category. */
  open: z.number().int().nonnegative(),
});
export type ReportCategoryRow = z.infer<typeof reportCategoryRowSchema>;

export const reportsSummarySchema = z.object({
  period: z.enum(REPORT_PERIODS),
  /** `business.timezone`: the period's days are local days there. */
  timeZone: z.string(),
  /** Start of the period: local midnight, (days − 1) days before today. */
  from: isoDate,
  /** When the numbers were computed (end of the period). */
  generatedAt: isoDate,
  tiles: z.object({
    /** Snapshot (now): open tickets — NEW, OPEN, PENDING. Opens the queue, All open. */
    open: z.number().int().nonnegative(),
    /** Open P1 tickets (red when > 0). Opens the Inbox P1 view. */
    p1Open: z.number().int().nonnegative(),
    /**
     * Open tickets that breached a target: the stored `slaBreached` flag, or a due date already
     * passed on the running clock (`hasBreachedSla`). Opens the Inbox "SLA at risk" view.
     */
    breached: z.number().int().nonnegative(),
    /** Open tickets nobody is assigned to. Opens the queue, Unassigned. */
    unassigned: z.number().int().nonnegative(),
    /** Period: tickets solved in the period and still solved or closed. Opens Solved. */
    solved: z.number().int().nonnegative(),
    /** Period: average first reply time (F11). */
    firstReply: firstReplyTileSchema,
  }),
  /**
   * Open tickets by category (F12): every active category in admin order (zeros included), then
   * archived categories that still have open tickets.
   */
  byCategory: z.array(reportCategoryRowSchema),
});
export type ReportsSummary = z.infer<typeof reportsSummarySchema>;
