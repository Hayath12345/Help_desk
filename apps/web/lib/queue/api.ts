// Typed fetchers of the Team queue API (docs/PHASE5_CONTRACT.md → API additions). Responses are
// parsed with the shared contract schemas outside production, like lib/tickets/api.ts. The list
// itself is GET /tickets (`fetchTickets` in lib/tickets/api.ts) with the queue's filters.

import {
  BULK_TICKETS_MAX,
  bulkTicketResultSchema,
  queueCountsSchema,
  queueFilterOptionsSchema,
  workloadSchema,
  type BulkTicketAction,
  type BulkTicketOutcome,
  type BulkTicketResult,
  type QueueCounts,
  type QueueFilterOptions,
  type Workload,
} from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';
import type { QueueFilters } from './keys';

/** GET /tickets/queue-counts — the four tab counts for the filters + search. */
export async function fetchQueueCounts(
  filters: QueueFilters,
  signal?: AbortSignal,
): Promise<QueueCounts> {
  const data = await apiClient.get<unknown>(withQuery('/tickets/queue-counts', { ...filters }), {
    signal,
  });
  return parseResponse(queueCountsSchema, data);
}

/** GET /tickets/workload — the agent cards (open / at-risk tickets per staff member). */
export async function fetchWorkload(signal?: AbortSignal): Promise<Workload> {
  const data = await apiClient.get<unknown>('/tickets/workload', { signal });
  return parseResponse(workloadSchema, data);
}

/** GET /tickets/filter-options — the Category filter (active, then archived ones in use). */
export async function fetchQueueFilterOptions(signal?: AbortSignal): Promise<QueueFilterOptions> {
  const data = await apiClient.get<unknown>('/tickets/filter-options', { signal });
  return parseResponse(queueFilterOptionsSchema, data);
}

/** POST /tickets/bulk — one request of at most BULK_TICKETS_MAX ids. */
export async function postBulkTickets(input: {
  ids: string[];
  action: BulkTicketAction;
}): Promise<BulkTicketResult> {
  const data = await apiClient.post<unknown>('/tickets/bulk', input);
  return parseResponse(bulkTicketResultSchema, data);
}

/** A bulk outcome, or a whole request that failed (its ids share the request's error). */
export type BulkRunOutcome = BulkTicketOutcome | { id: string; ok: false; requestError: unknown };

export interface BulkRunResult {
  /** One outcome per id, in selection order. */
  results: BulkRunOutcome[];
  /** The ok outcomes, including tickets that already were that way. */
  updated: number;
  /** The ok outcomes that changed a ticket (`changed: true`): what the toast counts. */
  changed: number;
  /** The ok outcomes that changed nothing (already assigned to the caller / already solved). */
  unchanged: number;
  failed: number;
}

/**
 * Runs a bulk action over any number of tickets: requests of BULK_TICKETS_MAX ids, one after the
 * other (the API rate-limits bulk per user, and each ticket runs the single-ticket rules). A
 * request that fails as a whole (network, 429, …) counts its ids as failed with that error, and
 * the next requests still run.
 */
export async function runBulkTickets(
  ids: readonly string[],
  action: BulkTicketAction,
): Promise<BulkRunResult> {
  const results: BulkRunOutcome[] = [];
  for (let start = 0; start < ids.length; start += BULK_TICKETS_MAX) {
    const chunk = ids.slice(start, start + BULK_TICKETS_MAX);
    try {
      const answer = await postBulkTickets({ ids: chunk, action });
      results.push(...answer.results);
    } catch (requestError) {
      results.push(...chunk.map((id) => ({ id, ok: false as const, requestError })));
    }
  }
  const updated = results.filter((r) => r.ok).length;
  const changed = results.filter((r) => r.ok && r.changed).length;
  return {
    results,
    updated,
    changed,
    unchanged: updated - changed,
    failed: results.length - updated,
  };
}
