# Phase 5 — handoff notes (views & reports)

Read [`PHASE4_HANDOFF.md`](PHASE4_HANDOFF.md), [`PHASE3_HANDOFF.md`](PHASE3_HANDOFF.md) and
[`PHASE2_HANDOFF.md`](PHASE2_HANDOFF.md) first. The Phase 5 build contract is
[`PHASE5_CONTRACT.md`](PHASE5_CONTRACT.md); its decisions F1–F17 hold as written, except where this file says
"as built".

## Where things stand

Phase 5 is built on top of Phase 4. One API + shared lane and three web lanes built it, two adversarial verifiers
(permissions and numbers; screens, accessibility and Arabic) tried to break it, and an integrator fixed every gap they
found with a regression test and a mutation check (32 of 32 caught). The verifiers found no security hole and no wrong
headline number.

**Done-when:** in the Team queue a filter + tab narrows the list and a bulk "Assign to me" updates the rows live; the
Reports numbers match a known set of tickets (`apps/api/test/reports.test.ts`) and each tile opens the matching
list; a customer row opens that company's tickets; a help article published in admin appears on an open portal Help
center page in English and Arabic without a reload, and an unpublished one never reaches clients
(`apps/web/e2e/views.spec.ts`, four tests, plus the API suites).

### What was built

- **No migration.** Every report is a visibility-scoped aggregate over the existing tables. If volume grows, the
  candidate indexes are `Ticket(solvedAt)`, `Ticket(firstRepliedAt)` and `Ticket(categoryId, status)`.
- **Shared** — `schemas/{queue,reports,customers,help}.ts`; the ticket list filters (`priority`, `categoryId`,
  `assigneeId` with `none`, `orgId`, `requesterId`) and `priority` sort; `p1NextStepSchema`; the activity-event DTOs;
  `hasBreachedSla` / `isSlaOverdue`; `helpArticleLanguage`; `AGENT_QUEUE_CAPACITY = 6`.
- **API** — `GET /tickets` filters, `GET /tickets/queue-counts`, `/tickets/workload`, `/tickets/filter-options`,
  `POST /tickets/bulk`, `GET /tickets/:id/events`, `GET /reports/summary`, `GET /customers`,
  `GET /customers/orgs/:id`, `GET /help/articles`, and `p1NextStep` on the ticket detail (the worker and the detail
  use one helper, `apps/api/src/lib/escalation.ts`).
- **Web** — `/console/queue`, `/console/customers`, `/console/reports`, the Inbox company view, the portal `/help`
  page, the Activity section in the console ticket panel, and the P1 banner's next-step line.

### Pages as built

- **Team queue** — header "All teams" (Super Admin) or "Your teams" · N unassigned (unfiltered); agent cards
  (open tickets against a capacity of 6, "N at risk" or "On track", click to filter by that person); tabs _All open_,
  _Unassigned_, _Breaching soon_ (at risk or overdue), _Solved_ with counts that follow the filters; Priority, Category
  (archived ones marked) and Assignee filters; tab, filters and search live in the URL. The top-bar search filters the
  queue in place. Selecting rows shows a bar with _Assign to me_, _Mark solved_, _Clear_. A row opens the ticket in the
  Inbox.
- **Customers** — "N requesters across M companies"; name, email, company with contract pill, open and total counts;
  search and _Load more_. A row opens the Inbox company view (`?org=`): all of that company's tickets in any status,
  titled with the company name, with a _Clear_ chip. The requester card's "N from this client" links there too.
- **Reports** — period picker (7 / 30 / 90 days); tiles _Open tickets_, _P1 open_, _SLA breached_, _Unassigned_ (all
  link to the matching list), _Solved_ and _Average first reply_ for the period; "Open tickets by category" bars.
- **Portal Help center** — published articles in the UI language, search as you type, first article open, language
  and direction per article, live refresh when an admin publishes or unpublishes.
- **Activity** (console ticket panel, staff only, collapsed by default) — who changed what and when, newest first,
  with archived and deleted items labelled.
- **P1 banner** — "escalation step N of M · next step in X" now follows the worker's real next step, also after an admin
  reorders the chain.

## Rules as built

- **Visibility (F2):** every new endpoint is scoped like the Inbox. Super Admin: all tickets. Agent and Team Lead:
  their teams' tickets plus tickets assigned to them. Clients get 403 on staff endpoints. A ticket the caller can't see
  is 404, and bulk reports invisible and unknown ids identically (`not_found`). Counts (workload, customers, reports)
  never include tickets the viewer can't open.
- **Queue counts:** each tab count equals the length of `GET /tickets` with the same filters and the tab's view
  (tested over 1,000+ combinations). Open tabs sort P1 → P4, running tickets before paused ones, then the next SLA due;
  Solved sorts newest first.
- **Bulk:** up to 50 ids per request (the page sends batches), 10 requests a minute per user; each ticket goes through
  the normal single-ticket update (permissions, events, notifications, realtime). `Assign to me` moves NEW to OPEN; a
  CLOSED ticket fails with `conflict`. The toast counts tickets that really changed, says how many were already
  assigned or solved, and names one failure reason; failed tickets stay selected.
- **Reports:** _open_ = NEW, OPEN, PENDING. _SLA breached_ = an open ticket whose stored breach flag is set, whose
  running clock is overdue, or whose first reply came after its due time. _Solved_ and _Average first reply_ cover the
  period, with days in `business.timezone` (daylight-saving gaps handled). Average first reply is measured on the SLA
  clock (24/7 for P1/P2, business hours for P3/P4) and is stored with the first-reply event
  (`slaMinutesToFirstReply`), so later priority changes don't rewrite history; older events are recomputed. "—" means
  no data. The _SLA breached_ number is not the length of the Inbox list it opens (that list also holds at-risk
  tickets).
- **Customers:** active, verified clients of active organisations, sorted in Unicode order; search covers name, email and
  company; counts under visibility; cursors reject malformed values with 400.
- **Help:** `GET /help/articles` returns published, active articles in admin order for any signed-in user. Arabic is used
  only when both the Arabic title and body exist, otherwise English with `lang`/`dir` set per article. Bodies are plain
  text.
- **Live data:** queue, agent cards, reports and customers refetch on `queue:updated`, after a reconnect and every
  60 s (queue, reports, customers); the refresh timer has a maximum wait so steady traffic can't postpone it. Filter
  options follow `ticket-form`, workload `teams`/`staff`, reports `ticket-form`/`calendar`, customers `form-context`,
  the Help center `help-center`. New query keys (`['queue']`, `['reports']`, `['customers']`, `['help']`,
  `['tickets','events',id]`) never live under `['tickets','list']`.
- **Accessibility:** the queue filters have names; focus stays sensible after bulk actions, _Load more_ and _Clear_;
  Arabic truncation puts the ellipsis at the text's own end; the tab strip scrolls the focused tab into view on phones;
  forced-colours mode distinguishes the selected tab and the pressed agent card; checkboxes have a 3:1 border.

## How to see it locally

- `pnpm dev`; sign in at http://localhost:3000/staff/login with the demo password. `hana.yousef@loonsgroup.com` (Team
  Lead) and `noor.alkaabi@loonsgroup.com` (Super Admin) show the scoping difference. Clients: `aisha.alkuwari@hamad.qa`
  at `/login`.
- Queue: open **Team queue**, filter by priority, switch tab, tick rows and press _Assign to me_.
- Reports: open **Reports** and click the tiles. Customers: click a row.
- Help center: keep `/help` open as a client, then publish an article in Admin → Help center; it appears without a reload.
- The P1 next-step line needs a live P1 with a chain (raise one as a client, then acknowledge it so nobody is paged).
  The seeded P1 tickets predate Phase 3 and have no chain.

## Testing notes

- New API suites: `team-queue`, `tickets-bulk`, `ticket-events`, `reports`, `customers`, `help-articles`,
  `p1-next-step`, `help-e2e-cleanup` (+ `openapi-tickets`); unit tests for the escalation helper and report time zones.
  The help suites take a Redis lock (`acquireTestLock`) because they share the global article list with
  `admin-help-center`.
- Web: component tests next to `components/console/{queue,customers,reports,activity}`, `inbox-company.test.tsx`, the
  portal help page, `lib/{queue,reports}`.
- E2E: `views.spec.ts` signs each person in once and reuses the session (login rate limits). Its help article uses the key
  `e2e-<13 digits>`; `db:cleanup-e2e` removes it together with the `[e2e:` tickets.

## Known limitations

- No presence dot on the agent cards (presence isn't stored on the server).
- Queue and customers page with _Load more_ (no virtualisation); fine for the expected volume.
- The display time zone of the app is still fixed to Asia/Qatar; only the API's report periods follow `business.timezone`.
- `queue:updated` doesn't reach an agent for a ticket assigned to them on another team; the 60 s refresh covers it.
- Seeded P1 tickets have no escalation chain, so they show no next-step line.
- The Next.js dev "N" badge appears in development screenshots only.

## Carry-overs for Phase 6 and later

- Phase 6: Dockerfiles, production configuration, health checks, deployment guide.
- An app-wide display time zone from `business.timezone`.
- From Phase 3/4: an organisation-level P1 create limit, a sweeper for deliveries stuck in `QUEUED`, a digest watermark,
  `params` on validation issues.
