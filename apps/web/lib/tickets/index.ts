// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/tickets — ticket data layer (docs/PHASE2_CONTRACT.md → Web → Data layer)
//
// TanStack Query over the browser `apiClient`; every query key starts with 'tickets'. Responses
// are parsed with the shared contract schemas outside production. Realtime (lib/realtime) keeps
// these caches live; the ticket UI lives in components/tickets.
//
// Setup: <ViewerProvider viewer={{ id, name, role }}> once per signed-in area (or
// <TicketingProviders> from components/tickets, which also mounts realtime + the New ticket modal).
//
// Queries (hooks)
//   useTicketFormConfig()            GET /config/ticket-form — categories → sub-types → fields, SLA policies, socPhone.
//   useFormContext(requesterId?, {enabled})  GET /tickets/form-context — requester, org (+contract), sites.
//                                    Staff pass the chosen client and keep it disabled until then.
//   useRequesterSearch(search)       GET /requesters (staff; pass a debounced search; keeps previous data).
//   useTickets(filters, {keepPrevious?})  GET /tickets, infinite (cursor). `data.items` = all loaded rows;
//                                    fetchNextPage / hasNextPage. filters: view|teamId|tab|scope|search|sort|limit.
//   useTicketCounts()                GET /tickets/counts — { kind: 'staff', views, teams } | { kind: 'client', tabs }.
//   useTicket(ref)                   GET /tickets/:ref (uuid or "LG-4817") → TicketDetailDto. 404 = not visible.
//   useMessages(ticketId)            GET /tickets/:id/messages (all pages) → ThreadMessage[] incl. optimistic ones.
//   useMacros() / useTeams()         Staff helpers (macros; teams with members for the assignee picker).
// Mutations (hooks)
//   useCreateTicket()                POST /tickets → caches the detail, refetches lists + counts.
//   useSendMessage(ticketId)         { send(input) → clientTempId, retry(msg), discard(msg), …mutation }:
//                                    optimistic pending bubble, predicted status (statusAfterMessage),
//                                    failed → Retry; deduplicated with realtime by id / clientTempId.
//   useUpdateTicket()                mutate({ ticketId, patch, optimistic? }): optimistic detail + list rows;
//                                    cancels only that ticket's queries; on error undoes only the fields it
//                                    wrote (newer realtime data stays), reloads the detail, toasts.
//   useAcknowledgeTicket()           mutate(ticketId): POST /tickets/:id/acknowledge (Phase 3), server-
//                                    confirmed; the answer's detail goes into every cached copy; errors
//                                    reload the detail and are left to the caller (the P1 banner).
// Viewer
//   ViewerProvider / useViewer() / isStaffViewer(viewer)   The signed-in user ({ id, name, role }).
// Cache helpers (pure; used by realtime and tests)
//   ticketKeys, normalizeTicketRef, normalizeListFilters
//   upsertThreadMessage, mergeThreadMessages, mergeServerMessages, sortThread, lastServerMessageId,
//   localMessages, setLocalMessageStatus, applyTicketSummary, applyTicketDetail, updateTicketEverywhere,
//   patchTicketEverywhere (optimistic patch → field-level rollback), queryHoldsTicket, findCachedTicket,
//   toSummary, selectTicketPages, isSameOrNewer
//   updateThread(queryClient, ticketId, fn, mode)  Writes a thread; parked until its first load finishes.
//   requestThreadCatchUp / takeThreadCatchUp / takeParkedThreadWrites   (realtime ↔ loadThread).
//   optimisticTicketPatch(queryClient, patch)  What a PATCH will look like (used by useUpdateTicket).
//   loadThread(queryClient, ticketId)         Thread fetch merged with whatever the cache holds when it
//                                    finishes (optimistic, pushed and parked messages): nothing is dropped.
// Fetchers: fetchTicketFormConfig, fetchFormContext, fetchRequesters, fetchTickets, fetchTicketCounts,
//   fetchTicket, createTicket, updateTicket, acknowledgeTicket, fetchMessagesPage, fetchAllMessages, postMessage,
//   fetchMacros, fetchTeams, withQuery, parseResponse.
// New ticket form model: NewTicketFormValues, emptyNewTicketValues, buildNewTicketSchema,
//   customFieldSchema, toCreateTicketInput, customFieldsPayload, effectivePriority,
//   securityCategory, findCategory, emptyCustomFieldValue, countFieldErrors, NEW_TICKET_ERRORS.
// Display helpers
//   localizedLabel / teamName / placeName / fieldPlaceholder   EN/AR labels (empty Arabic → English).
//   localizedAssetPlaceholder / useAssetPlaceholder()  Category asset placeholder ("e.g. FW-01" → "مثال: FW-01").
//   slaWindowParts, BUSINESS_DAY_MINUTES      "15 min" / "1 hour" / "2 business days" parts.
//   useSlaWindowFormatter()                  Formats a policy window in the UI language.
//   useApiErrorText()                        API error → errors.<CODE> sentence.
//   useTicketValidationMessage()             'validation.x' / 'tickets.x' keys → text.
//   newClientTempId()                        uuid v4 (crypto.randomUUID with a fallback).
// Types: ThreadMessage, SendMessageInput, LocalMessageStatus, TicketPages, TicketPagesWithItems,
//   AnyTicketDto, Viewer, TicketListFilters, UpdateTicketVariables, MessageAuthorRef.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export * from './api';
export * from './cache';
export * from './i18n';
export * from './ids';
export * from './keys';
export * from './labels';
export * from './mutations';
export * from './new-ticket-form';
export * from './queries';
export * from './sla-format';
export * from './types';
export * from './viewer';
