// ─────────────────────────────────────────────────────────────────────────────────────────────
// lib/queue — Team queue data layer (docs/PHASE5_CONTRACT.md F2–F7, F16)
//
// Keys (./keys.ts, prefix 'queue', never under ['tickets','list'])
//   queueKeys.list(filters) / count(filters) / workload() / filterOptions()
//   QUEUE_LIVE_KEYS, invalidateQueueLive(queryClient)   list + counts + workload (queue:updated,
//                                    reconnect, bulk, 60 s refresh); the filter options follow config.
// URL state (./url.ts): /console/queue?tab=&priority=&category=&assignee=&q=
//   parseQueueParams, queueQuery, queueHref, updateQueueUrl(patch, push|replace), useQueueState,
//   queueFiltersFor(state) (queue-counts), queueListFiltersFor(state) (GET /tickets: + view, sort),
//   queueTicketHref(ticket) (row → Inbox: Solved view for solved / closed tickets, All open otherwise).
// Queries (./queries.ts)
//   useQueueTickets(filters)         GET /tickets, infinite (cursor); keeps the previous rows while loading.
//   useQueueCounts(filters)          GET /tickets/queue-counts → { tabs: { open, unassigned, breaching, solved } }.
//   useWorkload()                    GET /tickets/workload → { capacity, agents }.
//   useQueueFilterOptions()          GET /tickets/filter-options → { categories }.
//   useBulkTickets()                 POST /tickets/bulk in requests of ≤ 50 ids → per-ticket outcomes;
//                                    invalidates the queue, Inbox lists / counts and touched details.
// Fetchers (./api.ts): fetchQueueCounts, fetchWorkload, fetchQueueFilterOptions, postBulkTickets,
//   runBulkTickets.
// UI: components/console/queue.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export * from './api';
export * from './keys';
export * from './queries';
export * from './url';
