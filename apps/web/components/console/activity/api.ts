// Data of the staff activity timeline (docs/PHASE5_CONTRACT.md F14): GET /tickets/:id/events,
// newest first, cursor-paged; staff only (clients get 403, a ticket the caller can't see is 404).

import { ticketEventListSchema, type TicketEventList } from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';

/**
 * Query keys: under 'tickets' like the rest of the ticket feature, but never under
 * ['tickets', 'list'] or ['tickets', 'detail'] (their cache shapes are relied on elsewhere).
 */
export const activityKeys = {
  all: () => ['tickets', 'events'] as const,
  events: (ticketId: string) => ['tickets', 'events', ticketId] as const,
};

/** Events per page ("Show more" loads the next). */
export const ACTIVITY_PAGE_SIZE = 20;

/** One page of a ticket's events (`ticketId`: the uuid). */
export async function fetchTicketEvents(
  ticketId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<TicketEventList> {
  const data = await apiClient.get<unknown>(
    withQuery(`/tickets/${encodeURIComponent(ticketId)}/events`, {
      cursor,
      limit: ACTIVITY_PAGE_SIZE,
    }),
    { signal },
  );
  return parseResponse(ticketEventListSchema, data);
}
