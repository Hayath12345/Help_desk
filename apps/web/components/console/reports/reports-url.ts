'use client';

// URL state of the console Reports page (Phase 5 F11): /console/reports?period=7d|30d|90d
// (default 30d, omitted from the URL). A period change pushes a history entry (Back returns to
// the previous period) through the History API, which Next.js syncs with useSearchParams().
// Also: where each tile leads (F10, F11).

import {
  DEFAULT_REPORT_PERIOD,
  REPORT_PERIODS,
  type QueueTab,
  type ReportPeriod,
} from '@loons/shared';
import { useSearchParams } from 'next/navigation';
import { queueHref } from '@/lib/queue/url';
import { inboxHref } from '../inbox-url';

export const REPORTS_PATH = '/console/reports';

interface ParamsLike {
  get(name: string): string | null;
}

export function isReportPeriod(value: string | null | undefined): value is ReportPeriod {
  return !!value && (REPORT_PERIODS as readonly string[]).includes(value);
}

/** The period of a query string; anything else is the default (30 days). */
export function parseReportPeriod(params: ParamsLike | null | undefined): ReportPeriod {
  const value = params?.get('period');
  return isReportPeriod(value) ? value : DEFAULT_REPORT_PERIOD;
}

/** `/console/reports?period=…` (the default period → the bare path). */
export function reportsHref(period: ReportPeriod): string {
  return period === DEFAULT_REPORT_PERIOD ? REPORTS_PATH : `${REPORTS_PATH}?period=${period}`;
}

/** Switches the period of the current URL (push; no-op when unchanged). */
export function pushReportPeriod(period: ReportPeriod): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (parseReportPeriod(url.searchParams) === period) return;
  if (period === DEFAULT_REPORT_PERIOD) url.searchParams.delete('period');
  else url.searchParams.set('period', period);
  window.history.pushState(null, '', url);
}

/** The period in the current URL (re-renders on pushState / Back). */
export function useReportPeriod(): ReportPeriod {
  return parseReportPeriod(useSearchParams());
}

// ───────────── Tile links ─────────────

/**
 * The Team queue with a tab selected and no filter (the Queue page's own URL helper:
 * `/console/queue?tab=`, "open" = All open is the default and omitted).
 */
export function queueTabHref(tab: QueueTab): string {
  return queueHref({ tab });
}

export const REPORT_TILES = [
  'open',
  'p1Open',
  'breached',
  'unassigned',
  'solved',
  'firstReply',
] as const;
export type ReportTile = (typeof REPORT_TILES)[number];

/**
 * Where a tile leads (F10, F11): Open → queue "All open"; P1 open → Inbox "P1 critical"; SLA
 * breached → Inbox "SLA at risk" (which lists breached tickets first); Unassigned → queue
 * "Unassigned"; Solved → Inbox "Solved". The average first reply has no list of its own (null).
 */
export function reportTileHref(tile: ReportTile): string | null {
  switch (tile) {
    case 'open':
      return queueTabHref('open');
    case 'p1Open':
      return inboxHref({ view: 'p1' });
    case 'breached':
      return inboxHref({ view: 'risk' });
    case 'unassigned':
      return queueTabHref('unassigned');
    case 'solved':
      return inboxHref({ view: 'solved' });
    case 'firstReply':
      return null;
  }
}
