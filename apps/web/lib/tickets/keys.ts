// TanStack Query keys for everything ticket-related. Every key starts with 'tickets' (contract),
// so one prefix covers the whole feature; narrower prefixes (lists(), details(), …) are used for
// targeted invalidation and cache updates.

import { parseTicketNumber, formatTicketNumber, type ListTicketsQuery } from '@loons/shared';

/** Filters of one ticket list. The cursor is the infinite query's page param, not part of the key. */
export type TicketListFilters = Partial<Omit<ListTicketsQuery, 'cursor'>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical form of a `:ref` ("lg-4817", "4817" → "LG-4817"; uuids lower-cased) so the same ticket
 * opened through different spellings shares one cache entry.
 */
export function normalizeTicketRef(ref: string): string {
  const trimmed = ref.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  const n = parseTicketNumber(trimmed);
  return n === null ? trimmed : formatTicketNumber(n);
}

/** Drops empty values and sorts keys so equivalent filter objects produce the same key. */
export function normalizeListFilters(filters: TicketListFilters): TicketListFilters {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries) as TicketListFilters;
}

export const ticketKeys = {
  all: ['tickets'] as const,
  formConfig: () => ['tickets', 'form-config'] as const,
  formContexts: () => ['tickets', 'form-context'] as const,
  formContext: (requesterId?: string | null) =>
    ['tickets', 'form-context', requesterId ?? 'self'] as const,
  /** Every requester search (prefix of `requesters`). */
  requesterSearches: () => ['tickets', 'requesters'] as const,
  requesters: (search: string) => ['tickets', 'requesters', search.trim()] as const,
  lists: () => ['tickets', 'list'] as const,
  list: (filters: TicketListFilters) => ['tickets', 'list', normalizeListFilters(filters)] as const,
  counts: () => ['tickets', 'counts'] as const,
  details: () => ['tickets', 'detail'] as const,
  detail: (ref: string) => ['tickets', 'detail', normalizeTicketRef(ref)] as const,
  allMessages: () => ['tickets', 'messages'] as const,
  messages: (ticketId: string) => ['tickets', 'messages', ticketId] as const,
  macros: () => ['tickets', 'macros'] as const,
  teams: () => ['tickets', 'teams'] as const,
};
