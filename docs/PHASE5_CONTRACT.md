# Phase 5 — Views & reports: build contract (binding)

> **Built 2026-10-01.** Where the implementation refines this contract (`p1NextStep` as a sibling of `p1Chain`, extra
> endpoints `GET /tickets/filter-options` and `GET /customers/orgs/:id`, no `phase5_views` migration, a Solved tab that
> sorts by last update), `docs/PHASE5_HANDOFF.md` → "Rules as built" is authoritative.

Scope (spec `docs/BUILD_SPEC.md` §14.5 with §1, §5): the console **Team queue** with filters, **Customers**,
**Reports** (open by category, P1 open, SLA breached, unassigned, average first reply time) and the portal **Help
center**, plus two carry-overs that belong with them (the staff activity timeline and the server-computed next P1
step). **Done when:** in the Team queue a filter + tab narrows the list and a bulk "Assign to me" updates the rows
live; the Reports numbers match a known set of tickets (API test) and each tile opens the matching list; a customer
row opens that company's tickets; a help article published in admin appears on an open portal Help center page in
EN and AR without a reload, and an unpublished one never reaches clients (automated E2E + API tests).

Out of scope: AWS packaging (Phase 6); an app-wide display time zone from `business.timezone` (the web keeps Asia/Qatar;
the API computes report periods in `business.timezone`); an organisation-level P1 create limit, a sweeper for stuck
deliveries, a digest watermark, `params` on validation issues (later).

Read first: `docs/PHASE4_HANDOFF.md`, `docs/PHASE3_HANDOFF.md`, `docs/PHASE2_HANDOFF.md`, README, `apps/web/AGENTS.md`.
The design of the four screens (strings, layout, behaviour, design line numbers) is extracted in the build notes the
lanes receive; the placeholder pages already follow the design's grids.

## Decisions (made for the owner — "what you deem fit"; each can be overridden later)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Look and feel:** reproduce the design's four screens (queue, customers, reports, help center) in the console / portal design language, EN/AR + RTL, 390 and 1280 px, skeletons while loading. Where the design is silent (errors, empty lists, paging) use the existing console patterns.                                                                                                                                                                                                                                                                                               |
| F2  | **Who sees what:** every staff role sees Team queue, Customers and Reports, always **scoped like the Inbox** (Super Admin: every ticket; Agent and Team Lead: their teams' tickets plus tickets assigned to them). Clients never reach these APIs (403). Numbers never include tickets the viewer can't open. The queue subtitle says "All teams" for Super Admins and "Your teams" otherwise.                                                                                                                                                                                            |
| F3  | **Team queue tabs:** _All open_ (NEW, OPEN, PENDING), _Unassigned_ (open, no assignee), _Breaching soon_ (the Inbox "SLA at risk" rule: at risk or already overdue, not paused), _Solved_ (SOLVED and CLOSED, newest first). Tab counts follow the active filters and the search. Open tabs sort P1 → P4, then the next SLA due date. Switching tab clears the selection.                                                                                                                                                                                                                 |
| F4  | **Filters:** Priority, Category (active categories, plus archived ones that still have tickets, marked), Assignee (the viewer's team members plus "Unassigned"); labels keep their prefix ("Priority: P1 Critical"). Filters, tab and search live in the **URL** (shareable, Back works), like the Inbox. The top-bar search filters the queue in place on this page.                                                                                                                                                                                                                     |
| F5  | **Agent cards:** one card per active staff member of the visible teams (Super Admin: every team), with their open assigned tickets (visible ones), a bar against a capacity of **6** (constant `AGENT_QUEUE_CAPACITY` in shared, as in the design) and "N at risk" or "On track". Sorted by open count, then name; clicking a card toggles the Assignee filter. No presence dot (presence is not stored server-side).                                                                                                                                                                     |
| F6  | **Bulk actions:** select rows (checkbox, select-all for the loaded rows) → a bar with "Assign to me", "Mark solved", "Clear". One request `POST /tickets/bulk` (≤ 50 ids) runs the normal single-ticket rules for each ticket (same permissions, events, notifications, realtime) and answers per ticket; the toast says "N updated" and, if any failed, "M couldn't be changed" with the reason for one of them. Assigning to yourself moves NEW to OPEN (existing rule).                                                                                                                |
| F7  | **Row click** opens the ticket in the Inbox (the Solved view for solved tickets, All open otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F8  | **Customers:** one row per active client requester — name, email, company with the contract pill (AMC / Billable), open and total ticket counts **counted over the tickets the viewer can see** (the list itself shows every active client, like the requester search staff already use to raise tickets on a client's behalf). Header "N requesters across M companies". Beyond the design (needed at scale): a search box (name, email, company) and "Load more" paging.                                                                                                                |
| F9  | **Company view:** clicking a customer opens the Inbox filtered to that company (`org` in the Inbox URL; all statuses, titled with the company name and a "clear" chip). The requester card's "N from this client" becomes a link to it.                                                                                                                                                                                                                                                                                                                                                   |
| F10 | **Reports — snapshot tiles** (now, scoped per F2): _Open tickets_, _P1 open_ (red when > 0), _SLA breached_ = open tickets that have breached a target (the stored `slaBreached` flag or a due date already passed without the reply / resolution; red when > 0), _Unassigned_. Each tile opens the matching list (queue All open, Inbox P1, Inbox SLA at risk — which lists breached tickets first —, queue Unassigned).                                                                                                                                                                 |
| F11 | **Reports — period tiles** with a period picker (Last 7 days / **Last 30 days** default / Last 90 days), days in `business.timezone`: _Solved_ (tickets solved in the period; opens the Solved view) and _Average first reply_ (mean time from creation to the first public staff reply for tickets first replied in the period, measured on the **SLA clock** — 24/7 for P1/P2, business hours for P3/P4 — so it compares with the targets; the subtitle gives the ticket count). The spec asks for the average; the design had no tile for it, so it is a sixth tile in the same style. |
| F12 | **Open tickets by category:** every active category in admin order plus archived categories that still have open tickets (marked), including zeros; bars relative to the largest; counts right-aligned.                                                                                                                                                                                                                                                                                                                                                                                   |
| F13 | **Help center (portal):** `GET /help/articles` for any signed-in user returns published, active articles in admin order; the language rule of the admin preview moves to `@loons/shared` (Arabic only when both the Arabic title and body exist, otherwise English, with the language returned so the page sets `lang`/`dir` per article). Plain text (no markdown/HTML), search as you type, the first article open, "Still need help?" → New ticket. Live refresh on the `help-center` config scope (and after a reconnect).                                                            |
| F14 | **Activity timeline** (Phase 3 carry-over): a staff-only "Activity" section in the console ticket panel listing the ticket's events (status, priority, assignee, team, category changes, SLA at risk / breached, escalation steps, acknowledge, auto-close) with who and when, labels resolved (archived items included), newest first, paged. `GET /tickets/:id/events` (staff only; 404 when the ticket is not visible).                                                                                                                                                                |
| F15 | **Next P1 step** (Phase 4 limitation): the ticket detail's staff-only `p1Chain` carries the server-computed next step (rule, due time) using the worker's "first rule not yet fired in this period" logic; the P1 banner shows it instead of counting step numbers.                                                                                                                                                                                                                                                                                                                       |
| F16 | **Live data:** the queue, agent cards and reports refetch on `queue:updated` / `ticket:updated` for visible tickets (debounced), after a reconnect, and every 60 s (at-risk changes with time); customers on `queue:updated`. New query key prefixes (`['queue', …]`, `['reports', …]`, `['customers', …]`, `['help', …]`) — never under `['tickets','list']`, whose cache shape the Inbox relies on.                                                                                                                                                                                     |
| F17 | **API conventions:** zod contracts in `packages/shared/src/schemas/{queue,reports,customers,help}.ts`; OpenAPI tags `tickets`, `reports`, `customers`, `help` (never under `/admin`); filters are always ANDed onto the Inbox visibility SQL; a ticket the viewer can't see is 404; per-user rate limit on bulk; indexes only if a query needs them (one migration `phase5_views`, e.g. `Ticket(categoryId, status)`, `Ticket(solvedAt)`, `Ticket(firstRepliedAt)`).                                                                                                                      |

## API additions

- `GET /tickets` gains `priority`, `categoryId`, `assigneeId` (`none` = unassigned), `orgId`, `requesterId` and a
  `priority` sort; `GET /tickets/queue-counts` (tab counts for the same filters + search); `GET /tickets/workload`
  (agent cards); `POST /tickets/bulk`; `GET /tickets/:id/events`.
- `GET /customers` (search, keyset paging by name, open/total counts under visibility).
- `GET /reports/summary?period=7d|30d|90d` (tiles + by category, one round trip).
- `GET /help/articles`.
- Ticket detail `p1Chain.next` (F15).

## Build plan (lanes)

1. **API + shared** (one lane, first): every contract above, services, OpenAPI, tests (incl. the Reports fixture test
   with exact expected numbers, visibility per role, bulk partial failures, business-time average), the migration if
   needed, the seed unchanged.
2. **Web** (three lanes in parallel, after 1): _Queue_ (page, URL state, tabs, filters, cards, table, bulk bar, search in
   place, live data); _Customers + Reports_ (both pages, company view in the Inbox, requester-card link); _Help center +
   timeline + banner_ (portal page, activity section, P1 banner next step). Each with EN/AR strings, component tests.
3. **Verify** — authorization and numbers (visibility per role on every new endpoint, report maths against fixtures,
   bulk rules), UI (a11y, RTL, 390/1280, forced colours, keyboard on tabs/filters/bulk bar/accordion).
4. **Integrate** — close gaps, full checks twice, E2E twice (incl. the done-when spec), screenshots for owner review.

## Tests

- **API:** each new route × role (client 403, agent/lead scope, super admin); filters combined with visibility; tab
  counts equal list lengths; workload counts; bulk (mixed visible/invisible/forbidden ids, per-ticket results, events and
  realtime emitted once per ticket); customers counts under visibility; reports numbers on a fixture (open, P1, breached
  via flag and via due date, unassigned, solved in period, business-time average) and period boundaries in the business
  time zone; help articles (unpublished/archived never returned, language fallback); events (labels, archived items,
  paging, 404 when invisible); `p1Chain.next` after a reorder.
- **Web:** queue URL state, tabs and filters, card toggle, bulk bar flows (partial failure toast), search in place;
  customers search and paging, company view; reports tiles and links, period switch, bars; help center search,
  accordion, language per article, live refresh; activity section; banner next step.
- **E2E (Playwright):** the done-when above, with `[e2e:` tickets and an `e2e-<13 digits>` help-article key removed by the
  teardown.
