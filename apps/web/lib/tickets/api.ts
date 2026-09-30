// Typed fetchers for the Phase 2 ticket API (docs/PHASE2_CONTRACT.md → API). They call the API as
// the signed-in user through `apiClient` (browser) and unwrap the response envelopes. Outside
// production every response is parsed with the shared contract schema, so a drift between the API
// and the web app fails loudly in development and tests instead of rendering garbage.

import {
  acknowledgeTicketResponseSchema,
  createMessageResponseSchema,
  formContextSchema,
  macroListSchema,
  messageListSchema,
  requesterListSchema,
  teamListSchema,
  ticketCountsSchema,
  ticketFormConfigSchema,
  ticketListSchema,
  ticketResponseSchema,
  type AcknowledgeTicketResponse,
  type CreateMessageInput,
  type CreateTicketInput,
  type FormContext,
  type MacroDto,
  type MessageDto,
  type TeamWithMembers,
  type TicketCounts,
  type TicketDetailDto,
  type TicketFormConfig,
  type TicketList,
  type TicketSummaryDto,
  type UpdateTicketInput,
} from '@loons/shared';
import type { z } from 'zod';
import { apiClient } from '@/lib/api/browser';
import type { TicketListFilters } from './keys';

type Query = Record<string, string | number | boolean | null | undefined>;

/** `path?a=1&b=x`, skipping empty values. */
export function withQuery(path: string, query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const STRICT = process.env.NODE_ENV !== 'production';

/**
 * Validates a response against its contract schema in development and tests (throws on drift);
 * in production the body is trusted as-is (the API serialises with the same schemas).
 */
export function parseResponse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  return STRICT ? schema.parse(data) : (data as z.output<S>);
}

const seg = (value: string) => encodeURIComponent(value.trim());

// ───────────── Config & form context ─────────────

export async function fetchTicketFormConfig(signal?: AbortSignal): Promise<TicketFormConfig> {
  const data = await apiClient.get<unknown>('/config/ticket-form', { signal });
  return parseResponse(ticketFormConfigSchema, data);
}

/** Clients omit `requesterId` (always themselves); staff pass the client they raise it for. */
export async function fetchFormContext(
  requesterId?: string | null,
  signal?: AbortSignal,
): Promise<FormContext> {
  const data = await apiClient.get<unknown>(
    withQuery('/tickets/form-context', { requesterId: requesterId ?? undefined }),
    { signal },
  );
  return parseResponse(formContextSchema, data);
}

export async function fetchRequesters(
  search: string,
  options: { limit?: number; signal?: AbortSignal } = {},
) {
  const data = await apiClient.get<unknown>(
    withQuery('/requesters', { search: search.trim(), limit: options.limit ?? 20 }),
    { signal: options.signal },
  );
  return parseResponse(requesterListSchema, data).items;
}

// ───────────── Tickets ─────────────

export async function fetchTickets(
  filters: TicketListFilters,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<TicketList> {
  const data = await apiClient.get<unknown>(withQuery('/tickets', { ...filters, cursor }), {
    signal,
  });
  return parseResponse(ticketListSchema, data);
}

export async function fetchTicketCounts(signal?: AbortSignal): Promise<TicketCounts> {
  const data = await apiClient.get<unknown>('/tickets/counts', { signal });
  return parseResponse(ticketCountsSchema, data);
}

/** `ref`: the ticket uuid or its "LG-4817" / "4817" number. */
export async function fetchTicket(ref: string, signal?: AbortSignal): Promise<TicketDetailDto> {
  const data = await apiClient.get<unknown>(`/tickets/${seg(ref)}`, { signal });
  return parseResponse(ticketResponseSchema, data).ticket;
}

export async function createTicket(input: CreateTicketInput): Promise<TicketDetailDto> {
  const data = await apiClient.post<unknown>('/tickets', input);
  return parseResponse(ticketResponseSchema, data).ticket;
}

export async function updateTicket(id: string, patch: UpdateTicketInput): Promise<TicketDetailDto> {
  const data = await apiClient.patch<unknown>(`/tickets/${seg(id)}`, patch);
  return parseResponse(ticketResponseSchema, data).ticket;
}

/**
 * POST /tickets/:id/acknowledge (staff; body-less, idempotent): acknowledges the P1. A repeat
 * answers 200 with `alreadyAcknowledged: true` and the first acknowledger on the ticket.
 */
export async function acknowledgeTicket(id: string): Promise<AcknowledgeTicketResponse> {
  const data = await apiClient.post<unknown>(`/tickets/${seg(id)}/acknowledge`);
  return parseResponse(acknowledgeTicketResponseSchema, data);
}

// ───────────── Messages ─────────────

const MESSAGE_PAGE = 200;
/** Safety net for very long threads (MESSAGE_PAGE × this many messages). */
const MAX_MESSAGE_PAGES = 20;

/** One page of messages (ascending), optionally only those after a message id. */
export async function fetchMessagesPage(
  ticketId: string,
  options: { after?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<MessageDto[]> {
  const data = await apiClient.get<unknown>(
    withQuery(`/tickets/${seg(ticketId)}/messages`, {
      after: options.after ?? undefined,
      limit: options.limit ?? MESSAGE_PAGE,
    }),
    { signal: options.signal },
  );
  return parseResponse(messageListSchema, data).items;
}

/** Every message (after `after`, when given), following pages until a short one. */
export async function fetchAllMessages(
  ticketId: string,
  options: { after?: string | null; signal?: AbortSignal } = {},
): Promise<MessageDto[]> {
  const all: MessageDto[] = [];
  let after = options.after ?? null;
  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const items = await fetchMessagesPage(ticketId, { after, signal: options.signal });
    all.push(...items);
    if (items.length < MESSAGE_PAGE) break;
    after = items[items.length - 1]?.id ?? null;
    if (!after) break;
  }
  return all;
}

export async function postMessage(
  ticketId: string,
  input: CreateMessageInput,
): Promise<{ message: MessageDto; ticket: TicketSummaryDto }> {
  const data = await apiClient.post<unknown>(`/tickets/${seg(ticketId)}/messages`, input);
  return parseResponse(createMessageResponseSchema, data);
}

// ───────────── Staff helpers ─────────────

export async function fetchMacros(signal?: AbortSignal): Promise<MacroDto[]> {
  const data = await apiClient.get<unknown>('/macros', { signal });
  return parseResponse(macroListSchema, data).items;
}

/**
 * Active teams with their active members; `includeArchived` adds archived teams after them (a
 * ticket on an archived team stays workable: its members are still offered, E6).
 */
export async function fetchTeams(
  signal?: AbortSignal,
  options: { includeArchived?: boolean } = {},
): Promise<TeamWithMembers[]> {
  const path = options.includeArchived ? '/teams?archived=include' : '/teams';
  const data = await apiClient.get<unknown>(path, { signal });
  return parseResponse(teamListSchema, data).items;
}
