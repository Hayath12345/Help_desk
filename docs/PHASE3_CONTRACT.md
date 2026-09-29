# Phase 3 — SLA & notifications: build contract (binding)

> **Built 2026-09-29.** Where the implementation refines this contract (a second migration for announcement
> retries, the staff-only `p1Chain` on the ticket detail, the `upTo` watermark on mark-all-read, the per-organisation
> share of the SMS cap, the unchanged `sla` sort order), `docs/PHASE3_HANDOFF.md` → "Rules as built" is authoritative.

Scope (spec `docs/BUILD_SPEC.md` §14.3, with §6, §7, §8, §9, §12): SLA worker (at-risk / breach flags, events,
notifications), auto-close, email templates via Mailpit, Microsoft Teams webhook, SMS provider, P1 acknowledge +
escalation chain, daily P4 digest, in-app notifications. **Done when:** a P1 ticket produces an email, a Teams post
and an SMS delivery record, and escalates if not acknowledged (automated tests), and the spec §12 E2E "P1 creation
triggers notifications" passes.

Out of scope: admin editing of rules/templates/teams (Phase 4), reports (Phase 5), AWS packaging (Phase 6), an
inbound-email channel, a client-facing notification bell.

Read first: `docs/PHASE2_HANDOFF.md` (architecture, limits, carry-overs), `docs/PHASE2_CONTRACT.md`, README.

## Decisions (made for the owner; each can be overridden later)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **One at-risk rule everywhere (spec §7):** a target is _at risk_ once `atRiskPercent` (SlaPolicy, default 75) of its window has elapsed **in SLA time** (business minutes for business-hours policies, wall-clock for 24/7), _breached_ at 100 %. It replaces Phase 2's "less than min(1 h, 50 %) left" rule in the UI colours, the `risk` view, the counts and the worker.                                                 |
| D2  | The at-risk instant is **computed server-side and stored** per target (`firstReplyAtRiskAt`, `resolveAtRiskAt`) wherever due dates are computed (create, priority change with pause replay, PENDING resume). The browser, SQL and worker all compare `now` with these instants — no calendar maths in the browser.                                                                                                          |
| D3  | **Escalation timing:** `EscalationRule.afterMins` is cumulative from the moment the ticket **became P1** (`Ticket.p1Since`: creation, or a later upgrade to P1). Seeded chain: step 1 on-call at 0, step 2 team leads at 5, step 3 operations manager at 15. Team-scoped rules, when a team has any active ones, **replace** the global chain for that team. Downgrading from P1 cancels the chain.                         |
| D4  | **P1 fan-out** (spec §9): the team distribution-list email and **one** Teams card go out as part of "ticket created / became P1"; escalation step 1 then emails + texts the on-call user (its TEAMS channel is that same card, not a second post). Later steps with TEAMS post an "escalated" card to the team webhook. A client-chosen P1 pages immediately, as the spec says; a per-recipient SMS cap limits abuse (D11). |
| D5  | **Acknowledge** = `POST /tickets/:id/acknowledge` by any staff member who can view the ticket (`canAcknowledgeP1`). Links in email / Teams / SMS open the console (`/console/inbox?ticket=LG-n`, sign-in required); **nothing acknowledges on GET** (mail scanners and link previews fetch links). The console shows a P1 banner with an Acknowledge button.                                                                |
| D6  | **Recipients:** "team lead" = `TeamMember.role = LEAD` of the ticket's team. Client reply → assignee (in-app + email); unassigned → the team's leads in-app + the team list by email. SLA at risk / breached → assignee + team leads (in-app + email); unassigned → leads only. Staff-created tickets notify like client-created ones.                                                                                      |
| D7  | **Locale:** each user gets their `User.locale`; team distribution lists and Teams cards are English.                                                                                                                                                                                                                                                                                                                        |
| D8  | **Auto-close:** SOLVED for `tickets.autoCloseDays` (5) **calendar** days → CLOSED (`closedAt`, `AUTO_CLOSED` event, `ticket:updated`); no email.                                                                                                                                                                                                                                                                            |
| D9  | **P4 digest:** P4 tickets skip the instant team email. A digest per team goes to the team list at `notifications.p4DigestTime` (AppSetting, default `07:30`, `business.timezone`) on business days only (not Fri/Sat or holidays), listing P4 tickets created since the previous business-day digest; empty digests are skipped.                                                                                            |
| D10 | **Historical safety:** the worker flags every crossed threshold, but sends notifications only for crossings in the last 60 minutes; older ones are flagged silently. Escalation only runs from delayed jobs scheduled when a ticket becomes P1, so existing tickets never page anyone.                                                                                                                                      |
| D11 | **SMS cap:** at most `SMS_MAX_PER_RECIPIENT_PER_HOUR` (default 20) texts per phone number per rolling hour; beyond it the SMS is recorded as `SKIPPED` (email / in-app still go). Phone numbers are normalised to E.164 in code.                                                                                                                                                                                            |
| D12 | **Teams provider** is config-selected like SMS: `TEAMS_PROVIDER=console` (default locally: logs one redacted line and records the delivery) or `webhook` (HTTPS only, host allow-list `TEAMS_WEBHOOK_HOSTS`, timeout `TEAMS_TIMEOUT_MS`). The webhook URL is a secret: never logged, never sent to browsers.                                                                                                                |
| D13 | **In-app notifications** are stored as `type` + `data` and rendered in the viewer's language by the web; a bell with unread count lives in the **console** top bar (staff). Clients keep email + the live thread (no portal bell in Phase 3).                                                                                                                                                                               |
| D14 | **Worker → browsers:** the worker publishes small events on a Redis channel (`<redisPrefix>worker-events`); every API instance subscribes, re-reads what it needs and emits through the existing realtime helpers (so eviction rules stay in one place). Works with or without the Socket.IO Redis adapter.                                                                                                                 |
| D15 | Notifications are enqueued **after commit** with deterministic job ids (best effort, like the realtime emits); time-based alerts are re-derived by the SLA scan. Each channel × recipient is its own job, so a retry never re-sends another channel.                                                                                                                                                                        |
| D16 | Events stay staff-visible through state, not a new timeline: SLA card (per-target at-risk / breached), P1 banner (step, acknowledged by / at). A staff activity timeline over `TicketEvent` is carried to Phase 5.                                                                                                                                                                                                          |

## Data model (one migration `phase3_sla_notifications`, on top of `attachment_visibility`)

- `Ticket`: `firstReplyAtRiskAt DateTime?`, `resolveAtRiskAt DateTime?` (D2), `p1Since DateTime?`,
  `p1EscalationStep Int @default(0)` (last step fired). Indexes for the scan: `(status, firstReplyAtRiskAt)`,
  `(status, resolveAtRiskAt)`. Existing tickets are backfilled by the first SLA scan (null instants with due dates).
- `TicketSlaSignal` (exactly-once SLA alerts across workers): `ticketId`, `target FIRST_REPLY|RESOLUTION`,
  `kind AT_RISK|BREACHED`, `dueAt`, `createdAt`, `@@unique([ticketId, target, kind, dueAt])` — a moved due date is a
  new signal. `Ticket.slaAtRiskAt` / `slaBreached` / `slaBreachedAt` stay as summary flags (breached is sticky for
  reporting; at-risk is cleared when no target is at risk).
- `NotificationDelivery` (the email / Teams / SMS log, spec §9 "dead-letter logging", the done-when evidence):
  `channel EMAIL|TEAMS|SMS`, `templateKey`, `ticketId?`, `userId?`, `teamId?`, `recipientMasked` (e-mail kept, phone
  masked, webhook = host only), `status QUEUED|SENT|FAILED|SKIPPED`, `providerMessageId?`, `error?` (redacted),
  `dedupeKey @unique`, `attempts`, `createdAt`, `sentAt?`. Retention 90 days.
- `Notification`: `dedupeKey String? @unique`, `title` becomes optional (the web renders from `type` + `data`),
  `@@index([ticketId])`. Retention: read notifications older than 90 days are deleted.
- `EscalationRule`: unique `(priority, teamId, step)` with NULLS NOT DISTINCT (hand-written SQL); doc comment per D3.
- Seed (create-only): AppSetting `notifications.p4DigestTime = "07:30"`, `tickets.securityCategoryKey = "cyber"`;
  2028 Qatar holidays; demo teams keep `teamsWebhookUrl = null` (console provider locally).

## Shared contracts (`packages/shared`)

- Ticket summary/detail DTOs gain `firstReplyAtRiskAt`, `resolveAtRiskAt`, `slaBreached`, `p1Since`,
  `p1EscalationStep`, `p1AckedAt`, `p1AckedBy {id, name} | null`, `closedAt`.
- `slaState()` / `isSlaAtRiskOrBreached()` use the stored instants (D1/D2); the API's SQL twin agrees.
- `acknowledgeTicketResponseSchema`; notification DTO `{id, type, ticketId, ticketNumber?, data, readAt, createdAt}`,
  `listNotificationsQuerySchema` (cursor, `unreadOnly`), `notificationListSchema` (`items`, `nextCursor`,
  `unreadCount`), `markNotificationsReadSchema` (`{ids}` or `{all: true}`); typed `notification:new` payload.
- Worker event payloads (D14) and queue job payload schemas (zod; invalid ⇒ `UnrecoverableError`).

## API + worker (`apps/api`)

- **Routes:** `POST /tickets/:id/acknowledge` (staff, rate-limited, idempotent: a second ack returns 200 with the
  first acknowledger), `GET /me/notifications`, `POST /me/notifications/read`. OpenAPI + `limitGuard` like Phase 2.
- **Producers** (after commit, D15): ticket create; PATCH priority to/from P1 (starts/cancels the chain) and any
  due-date change (recompute at-risk instants); staff PUBLIC reply; client reply; acknowledge.
- **Worker:** `WorkerDeps` gains Prisma, SMS, Teams, email rendering, a clock and config. Schedulers via
  `upsertJobScheduler` (bullmq 6 rejects `repeat`): `sla-scan` every 60 s, `auto-close` every 15 min, `p4-digest`
  (cron, `business.timezone`), `orphan-sweep` every 30 min (PENDING/REJECTED attachments older than 30 min: rows +
  objects best effort), `retention` daily. `WORKER_SCHEDULERS=false` lets a worker only consume.
- **Queues:** `notifications` (one job per channel × recipient), `sla` (scan, auto-close, digest, sweep, retention),
  new `escalation` (delayed P1 steps, jobId `p1-esc-<ticketId>-<p1SinceMs>-<step>`). Every processor re-reads state
  and is a no-op when the ticket is gone, closed, no longer P1, already acknowledged or `p1Since` moved; step
  processors re-read the active rules when they fire.
- **SLA scan:** mirrors the Phase 2 pause rules (a PENDING ticket's resolution clock is paused; an unanswered PENDING
  keeps its first-reply clock); inserts `TicketSlaSignal` first, and only the inserter writes the `TicketEvent`,
  updates the summary flags, enqueues notifications (D10) and publishes a worker event.
- **Emails** (`packages/emails`): built-in EN/AR defaults for the nine ticket templates (matching the seeded wording),
  CTA labels, greeting-less rendering for distribution lists, formatters (priority labels, target durations, dates in
  `business.timezone`, "Unassigned"), and the Phase 1 carry-over **block variables** (`description`, `messageBody`,
  `ticketList`: paragraphs kept, never linkified, truncated at 2,000 characters with a "view the full message" line).
- **Teams / SMS:** adaptive card with facts (number, priority, team, org, category) and `Action.OpenUrl` buttons
  (Open ticket, Acknowledge) built from `APP_URL`; every client-supplied string is escaped for Teams Markdown. SMS
  text (EN/AR by recipient): `LG-n P1 <team> <category>` + console link — no subject or client names.
- **Logging:** phone numbers and webhook URLs are added to the pino redaction and `redactPii`.

## Web (`apps/web`)

- **Console bell** (top bar): unread badge, list sheet or popover (newest first, cursor paging, mark one / all read),
  live via `notification:new`, EN/AR + RTL, keyboard and screen-reader friendly; items deep-link to the ticket.
- **P1 banner** in the conversation header while P1 and unacknowledged: step N of M, next escalation time, Acknowledge
  button (server-confirmed, then "Acknowledged by X · time"). List rows show an unacknowledged-P1 marker.
- **SLA display** follows D1/D2 (row colours, SLA card per target, breached state); the `risk` view and counts come
  from the API.
- Phase 2 carry-over: forced-colors focus for `components/ui/**` and `components/shell/**` (the bell lives there).
- Design: the approved prototype has no bell or acknowledge UI; build them in its language (tokens, spacing, pill and
  card styles) and report screenshots for owner review.

## Tests

- **Unit:** at-risk instants in business and 24/7 time incl. pauses and priority replay; escalation schedule (D3);
  digest window (weekends, holidays); E.164 normalisation; Teams escaping; block variables; SMS cap.
- **API / worker integration** (real Postgres, Redis, Mailpit; injectable clock and escalation delays): P1 create ⇒
  team list email + Teams delivery + on-call email + SMS delivery; not acknowledged ⇒ step 2 then step 3 fire; ack ⇒
  later steps never fire; upgrade / downgrade; two concurrent workers never double-send; SLA scan idempotent and
  honours pauses; auto-close races a client reopen; P4 skips the instant email and appears in the digest; missing
  ticket ⇒ no-op, not dead-letter; notification list / read endpoints and `notification:new` via the bridge.
- **E2E (Playwright):** a client raises a P1 ⇒ Mailpit receives the team and on-call emails, `NotificationDelivery`
  holds the TEAMS and SMS records (read through `@loons/db` like the teardown), the agent sees the P1 banner and the
  bell, acknowledges, and the banner switches to "Acknowledged". Teardown also removes the tickets' queued jobs.
- Existing suites keep passing; tickets created by tests must not leak jobs that fire later.
