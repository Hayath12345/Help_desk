# Phase 3 — handoff notes (SLA & notifications)

Read [`PHASE2_HANDOFF.md`](PHASE2_HANDOFF.md) first. The Phase 3 build contract is
[`PHASE3_CONTRACT.md`](PHASE3_CONTRACT.md); its decisions D1–D16 hold as written, except where this file says
"as built".

## Where things stand

Phase 3 is built on top of Phase 2 and the owner-approved Phase 2 upload follow-ups (upload visibility, daily upload
budget, mismatched images — see `PHASE2_HANDOFF.md`). Four lanes built it (foundation, templates, API + worker,
web), three adversarial verifiers tried to break it (reliability, security, UI), and an integrator fixed every
medium/high gap they found plus most low ones. Every fix has a regression test and a mutation check.

**Done-when:** a P1 produces the team-list email and the on-call email (Mailpit), a Teams post and an SMS
(`NotificationDelivery` rows), and escalates to steps 2 and 3 when not acknowledged; acknowledging stops the chain
(`apps/api/test/p1-notifications.test.ts`, plus the spec §12 E2E `apps/web/e2e/notifications.spec.ts`).

### What was built

- **Data** — migrations `20260929075550_phase3_sla_notifications` and `20260929100542_phase3_sla_signal_retry`:
  per-target at-risk instants on `Ticket` (`firstReplyAtRiskAt`, `resolveAtRiskAt`), the P1 period (`p1Since`,
  `p1EscalationStep`), `slaTargetsChangedAt`; `TicketSlaSignal` (exactly-once SLA alerts, with `notify` /
  `enqueuedAt` for announcement retries); `NotificationDelivery` (the email / Teams / SMS log); `Notification`
  `dedupeKey` and optional `title`; a unique `(priority, teamId, step)` on `EscalationRule`. Seed: AppSettings
  `notifications.p4DigestTime = "07:30"`, `tickets.securityCategoryKey = "cyber"`, 2028 Qatar holidays.
- **Shared** — `computeSlaTargets` (at-risk instants in SLA time), `slaState()` on the stored instants, DTO fields
  (`firstReplyAtRiskAt`, `resolveAtRiskAt`, `slaBreached`, `p1Since`, `p1EscalationStep`, `p1AckedAt`, `p1AckedBy`,
  `closedAt`, staff-only `p1Chain` on the detail), notification schemas, typed `notification:new`.
- **Templates** (`packages/emails`) — built-in EN/AR defaults for the nine ticket emails (same wording as the seed),
  block variables (`description`, `messageBody`, `ticketList`: paragraphs kept, never linkified, 2,000-character cap),
  greeting-less list emails, formatters, the Teams Adaptive Card builder and the SMS text builder.
- **API** — `POST /tickets/:id/acknowledge`, `GET /me/notifications`, `POST /me/notifications/read`; producers after
  commit for create, P1 start/stop, staff public reply, client reply and acknowledge.
- **Worker** (`apps/api/src/jobs/*`) — schedulers (SLA scan every minute, auto-close every 15 min, P4 digest,
  orphan-upload sweep every 30 min, retention daily); queues `notifications` (one job per channel × recipient),
  `sla`, `escalation` (delayed P1 steps); Teams provider (`console` | `webhook`), SMS provider with E.164 numbers and
  the SMS cap; the worker → browser bridge over Redis pub/sub.
- **Web** — the console bell (unread badge, list, mark read, live updates; also in the admin shell, which reuses the
  console top bar), the P1 banner with Acknowledge, SLA display on the stored instants, and forced-colors focus for
  `components/ui/**` and `components/shell/**` (the Phase 2 carry-over).

## Rules as built

- **At risk / breached (D1, D2):** at risk once `atRiskPercent` (75) of a target's window has passed in SLA time;
  breached at the due date. The instants are stored whenever due dates are computed; the SLA scan backfills older
  tickets (capped at their stored due date). The `sla` sort order is unchanged (done, replied, paused, next due date).
- **Escalation (D3):** step 1 is scheduled when a ticket becomes P1; each step, when it fires, re-reads the active
  rules and schedules the next one, so at most one step job is pending. Every step re-checks priority, status,
  acknowledgement and `p1Since` first. Step jobs retry for about 30 minutes, and the SLA scan re-schedules an overdue
  step without a live job for P1 periods started in the last 24 hours. `ROLE TEAM_LEAD` means the team's
  `TeamMember` leads; `SUPER_ADMIN` means every active super admin.
- **P1 banner:** "escalation step N of M · next step in X (hh:mm)" from `p1Chain`, `p1Since` and `p1EscalationStep`;
  list rows show "step N". A P1 without a period (created before Phase 3, `p1Since` null) shows only its title and can
  still be acknowledged. A solved or closed P1 that nobody acknowledged shows no banner.
- **Upgrade to P1 later:** the team list gets the P1 alert (not the "new ticket" email), and the chain starts at the
  upgrade. Downgrading clears `p1Since` and cancels pending steps; deliveries still queued for an ended or
  acknowledged P1 are recorded as `SKIPPED`.
- **SLA scan:** the first worker to insert a `TicketSlaSignal` writes the event and announces it; a failed
  announcement is retried by later scans for 60 minutes. Only crossings from the last 60 minutes are announced (D10);
  a priority change that puts a crossing in the past counts from the change. Alerts are re-checked against the live
  target before they go out. `Ticket.slaAtRiskAt` follows the live rule; `slaBreached` is sticky.
- **Deliveries** are at least once: a delivery whose lock is held by another worker fails and is retried; a worker
  killed after sending but before recording `SENT` sends again.
- **SMS cap (D11 as built):** per phone number `SMS_MAX_PER_RECIPIENT_PER_HOUR` (20), and per number and organisation
  a quarter of it (5), so one customer's P1 flood can't silence pages for others. Refusals are `SKIPPED` with the
  reason.
- **P4 digest (D9):** a scheduler tick that came due while no worker was running survives a restart and covers the
  day it was due. The digest time is read when the worker starts.
- **Mark all read** sends an `upTo` watermark, so notifications that arrive meanwhile stay unread.
- **Email text:** bidi control characters from client text are stripped from subjects and bodies.

## How to see it locally

- Emails: Mailpit at http://localhost:8025.
- Teams and SMS: `TEAMS_PROVIDER=console` and `SMS_PROVIDER=console` write one redacted line each to the worker log,
  and every send is a row in `NotificationDelivery` (for example
  `select channel, "templateKey", status, "recipientMasked", "createdAt" from "NotificationDelivery" order by "createdAt" desc limit 20;`).
- Raise a P1 as a client (for example a Cybersecurity "Security alert" ticket): the SOC list and Maya Ruiz get the
  emails, the console Teams and SMS lines appear, Maya's bell and the P1 banner show it. Step 2 pages the team leads
  **5 real minutes** later unless someone acknowledges.
- Automated demo with scaled time: `pnpm exec vitest run test/p1-notifications.test.ts` in `apps/api`
  (`escalationMinuteMs` makes a minute a few hundred milliseconds). Never change `.env` for a demo.

## Testing notes

- New API suites: `deliver`, `escalation-net`, `historical-safety`, `maintenance`, `notifications-api`,
  `notify-producers`, `p1-concurrency`, `p1-notifications`, `phase3-schema`, `sla-scan`, `sms-cap`, `worker-bridge`
  (+ unit tests next to `lib/escalation`, `lib/phone`, `jobs/local-time`, `lib/logger`). They run workers in-process
  with their own BullMQ and Redis prefixes and an injectable clock.
- E2E: `notifications.spec.ts` texts Maya Ruiz's number once per run for Hamad Medical. More than 5 runs within an
  hour hit the organisation's SMS share and the spec (which requires `SENT`) fails: wait an hour or delete the
  `loons:sms-cap*` Redis keys. Playwright's extra worker runs with `WORKER_SCHEDULERS=false`. The e2e teardown also
  removes the queued jobs, deliveries and notifications of the tickets it deletes.
- The dev database keeps the seeded email templates it was created with (the seed is create-only); the worker supplies
  both old and new template variables, so older rows still render.

## Known limitations

- Client P1 floods: email, Teams and in-app notifications are not capped, and ticket creation is limited per user,
  not per organisation (SMS is capped as above).
- An already-scheduled escalation step keeps its time if its rule's `afterMins` is edited (only matters once Phase 4
  lets admins edit rules).
- A worker outage spanning more than one business-day digest time loses the middle day's digest window.
- The Teams card was checked against Microsoft's documented format, not posted to a real webhook; custom
  `TEAMS_WEBHOOK_HOSTS` are trusted as configured (no DNS pinning).
- Log redaction does not catch phone numbers written without `+` or `00`, or URLs without a scheme.
- A step job that completed without firing (the ticket was solved at that moment and reopened later in the same P1
  period) is not resumed.
- Staff phone numbers and on-call users can only be set by the seed until the Phase 4 admin exists.

## Carry-overs for Phase 4 and later

- Admin for escalation rules, templates, teams (on-call user, list, webhook), SLA policies: re-check step timing when a
  step fires, bust the cached `p1Chain`, invalidate principals on member changes, and emit `config:updated`.
- An organisation-level P1 create limit, or coalesced escalation cards.
- A sweeper for deliveries stuck in `QUEUED`; a digest window based on the last digest actually sent.
- Phase 5: a staff activity timeline over `TicketEvent` (SLA, escalation, acknowledge, auto-close events are written
  but only visible through the SLA card and the P1 banner today).
