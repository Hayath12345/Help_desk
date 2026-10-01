'use client';

// TanStack Query hook of the Reports page. Keys: ./keys.ts.

import type { ReportPeriod } from '@loons/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { isApiRequestError } from '@/lib/api/errors';
import { fetchReportsSummary } from './api';
import { reportKeys } from './keys';

/**
 * The snapshot tiles change with time (a due date passes → "SLA breached"), not only with
 * events: refetch every minute while the tab is visible (TanStack pauses the interval in the
 * background).
 */
export const REPORTS_REFRESH_MS = 60_000;

/** Don't retry answers that won't change (403 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * Reports for a period. While another period loads the previous numbers stay
 * (`isPlaceholderData`), so the snapshot tiles don't flash.
 */
export function useReportsSummary(period: ReportPeriod) {
  return useQuery({
    queryKey: reportKeys.summary(period),
    queryFn: ({ signal }) => fetchReportsSummary(period, signal),
    placeholderData: keepPreviousData,
    refetchInterval: REPORTS_REFRESH_MS,
    retry: retryTransient,
  });
}
