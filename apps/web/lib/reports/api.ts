// Typed fetcher of the Phase 5 Reports API (staff only; api-contracts: GET /reports/summary).

import { reportsSummarySchema, type ReportPeriod, type ReportsSummary } from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';

/**
 * GET /reports/summary?period= — snapshot tiles (now), period tiles (the last 7 / 30 / 90 days in
 * `business.timezone`) and open tickets by category, over the tickets the caller can see.
 */
export async function fetchReportsSummary(
  period: ReportPeriod,
  signal?: AbortSignal,
): Promise<ReportsSummary> {
  const data = await apiClient.get<unknown>(withQuery('/reports/summary', { period }), { signal });
  return parseResponse(reportsSummarySchema, data);
}
