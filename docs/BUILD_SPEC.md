# Build Prompt — Loons Help Desk (for Claude Code)

> Before starting: put the final design file in the repo at `design/Loons Help Desk_final.html`.

---

You are building **Loons Help Desk**, a production-grade ticketing and support platform for Loons Group (Qatar-based cybersecurity, ICT infrastructure and ELV systems integrator). Clients (government, banking, healthcare, oil & gas) raise tickets about systems Loons installed or manages; Loons staff triage, chat with clients and resolve them.

Work in phases. **At the end of each phase, stop, summarise what was built, list how to run and test it, and wait for my approval before starting the next phase.**

## 1. Design reference (source of truth for UI)

- The approved design is `design/Loons Help Desk_final.html` (a bundled prototype — open it in a browser and click through every screen before writing UI code).
- Screens to reproduce: client sign-in (with Google + Arabic toggle), staff sign-in, client portal (My tickets with All/Active/Solved tabs, ticket thread, Help center, New ticket modal), agent console (Inbox with Views + Teams sidebar, queue list sorted by SLA, conversation thread with Public reply / Internal note composer and macros, right panel with SLA countdown, status segmented control, properties and requester card), Team queue, Customers, Reports.
- Match it closely: Geist font, light grey page background, white bordered cards, royal-blue primary (#4063d8), monospace ticket IDs, coloured status pills, yellow internal-note bubbles, P1–P4 priority colours. Extract these into Tailwind theme tokens — no hardcoded hex values in components.
- **Motion** (use Motion / framer-motion): modal scale+fade in, list items animate in/out and reorder with `layout`, status pill colour transitions, new chat messages slide in, side sheets slide from the inline-end edge, skeleton loaders instead of spinners. Durations 150–250 ms, ease-out. Respect `prefers-reduced-motion`.
- Perceived speed matters more than animation: use optimistic updates for replies, status, priority and assignee changes.

## 2. Stack (do not substitute without asking)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript strict everywhere |
| Frontend | Next.js (App Router), Tailwind CSS, shadcn/ui (Radix), Motion, TanStack Query, React Hook Form + Zod, next-intl (EN/AR) |
| API | Node + Fastify (REST), Zod validation, OpenAPI docs via fastify-swagger |
| Realtime | Socket.IO (server in `apps/api`, client in `apps/web`); Redis adapter wired but switchable |
| Database | PostgreSQL + Prisma (migrations committed) |
| Jobs / queues | BullMQ + Redis (notifications, SLA checks, escalation) |
| Auth | Auth.js for clients (email/password with argon2 + Google); staff via Microsoft Entra ID (OIDC). JWT for API + socket auth. MFA-ready for staff |
| Files | S3-compatible storage via AWS SDK v3 (MinIO locally, S3 in prod), pre-signed uploads |
| Email | React Email templates; SMTP transport locally (Mailpit), AWS SES in prod — behind one `EmailProvider` interface |
| SMS | `SmsProvider` interface: console logger locally, AWS SNS in prod |
| Teams alerts | Incoming webhook URL per team (stored in admin settings) |
| Testing | Vitest (unit), Playwright (critical E2E flows) |

## 3. Repository structure

```
loons-helpdesk/
├─ apps/
│  ├─ web/          Next.js client portal + agent console + admin panel
│  └─ api/          Fastify REST + Socket.IO + BullMQ workers (separate worker entrypoint)
├─ packages/
│  ├─ db/           Prisma schema, migrations, seed script
│  ├─ shared/       Zod schemas, types, enums, SLA + business-hours utilities
│  ├─ emails/       React Email templates
│  └─ ui/           shared design tokens (optional)
├─ design/          Loons Help Desk_final.html
├─ docker-compose.yml   postgres, redis, minio, mailpit
├─ .env.example
└─ README.md
```

## 4. Environment — local first, AWS later

- Local: `docker compose up` starts Postgres, Redis, MinIO and Mailpit. `pnpm dev` runs web + api + worker.
- **Everything must be AWS-ready by config only**: `DATABASE_URL` (→ RDS PostgreSQL), `REDIS_URL` (→ ElastiCache), `S3_*` (→ S3), `EMAIL_PROVIDER=smtp|ses`, `SMS_PROVIDER=console|sns`. No local-only shortcuts (no files on local disk, no in-memory timers, no console-only emails).
- Include Dockerfiles for `web`, `api` and `worker`, and a health-check endpoint on the API.
- Target AWS region is configurable (expected: me-central-1 or me-south-1).

## 5. Roles & permissions

- **Client** — sees only tickets of their own organisation; can create, reply, attach, mark solved. Never sees internal notes.
- **Agent** — sees their team's tickets and assigned tickets; reply, internal note, change status/priority/assignee.
- **Team Lead** — Agent + manage their team's macros and members.
- **Super Admin** — everything, including the admin panel.
- Enforce authorisation **on the server** (API + socket), never only in the UI. Staff are identified by `@loonsgroup.com` via Entra ID.

## 6. Data model (Prisma)

Core: `Organization` (client company; contract type AMC/Billable, AMC expiry, account manager), `Site` (belongs to org), `User` (role, org or team, locale), `Team`, `TeamMember`, `Ticket`, `Message` (type: PUBLIC | INTERNAL | SYSTEM), `Attachment`, `Tag`, `TicketTag`, `TicketEvent` (status/priority/assignee history).

Configuration (edited in admin panel): `Category` (key, labelEn, labelAr, icon, teamId, sortOrder, isActive), `Subtype` (categoryId, key, labelEn, labelAr, defaultPriority, sortOrder, isActive), `CustomField` (key, labelEn, labelAr, type, options JSON, required, isActive), `CategoryField` (categoryId, fieldId, sortOrder), `SlaPolicy` (priority, firstReplyMins, resolveMins, businessHoursOnly), `BusinessHours` (weekday, open, close), `Holiday` (date, name), `EscalationRule` (priority, step, target role/user, afterMins, channel EMAIL|TEAMS|SMS), `Macro`, `EmailTemplate` (editable subject/body text), `HelpArticle`, `Notification`, `AdminAuditLog` (actorId, entity, entityId, before JSON, after JSON, createdAt).

Ticket fields: `number` (human ID `LG-4817`, sequence-based), type (INCIDENT | SERVICE_REQUEST | CHANGE_REQUEST | SECURITY_INCIDENT | ENQUIRY), subject, description, categoryId, subtypeId, priority (P1–P4), impact (SINGLE_USER | DEPARTMENT | ENTIRE_SITE | MULTIPLE_SITES), status (NEW | OPEN | PENDING | SOLVED | CLOSED), orgId, siteId, assetId, requesterId, assigneeId, teamId, `customFields` (JSONB), `firstReplyDueAt`, `resolveDueAt`, `firstRepliedAt`, `solvedAt`, `slaBreached`, `p1AckedAt`, `p1AckedBy`.

Rules: never hard-delete config records (archive with `isActive=false`); tickets keep referencing archived items and still display them. Stable `key` separate from labels. Index status, priority, teamId, assigneeId, orgId, dueAt columns.

## 7. Ticket logic

- **Create**: validate against the **live** config (build the Zod schema at request time from DB config, cached in Redis). Default priority from subtype; user may override. Route to the category's team. Calculate SLA due dates using business hours + holidays (Qatar weekend = Friday & Saturday; P1 and P2 run 24/7, P3/P4 business hours only — configurable).
- **Security Incident** type forces category Cybersecurity / SOC.
- **Status flow**: NEW → OPEN (on first agent touch) → PENDING (waiting on client) ↔ OPEN → SOLVED → CLOSED (auto after 5 days solved). Client reply on a SOLVED ticket reopens it.
- **SLA**: first public agent reply sets `firstRepliedAt`. A BullMQ repeatable job every minute flags "SLA at risk" at 75% of the window and breaches at 100% (emits events + notifications). PENDING pauses the resolution clock.
- Every change writes a `TicketEvent`.

## 8. Realtime chat (Socket.IO)

- Authenticate the socket handshake with the JWT; reject otherwise.
- Rooms: `ticket:{id}` (client + staff), `ticket:{id}:staff` (internal notes, typing from staff), `team:{id}` (queue updates), `user:{id}` (personal notifications).
- Authorise every room join on the server (clients only their org's tickets).
- **Persist to DB first, then broadcast.** Include a client-generated temp ID for optimistic UI reconciliation.
- On reconnect, the client fetches messages after its last known message ID.
- Events: `message:new`, `message:typing`, `ticket:updated`, `queue:updated`, `notification:new`, `config:updated`.
- Internal notes must never be emitted to client sockets — add a test for this.

## 9. Notifications & P1 escalation (BullMQ workers)

- **Ticket created** → email the routed team's distribution list (not everyone) + acknowledgement email to the client with ticket number and target response time. P4 tickets go into a daily digest instead of an instant team email.
- **P1 created** → immediately: email team + post to team's Teams webhook (adaptive card with ticket link and an "Acknowledge" link) + SMS to on-call engineer. If not acknowledged within the rule's `afterMins` (default 5), escalate to next step (Team Lead, then Manager). Stop escalating as soon as acknowledged (`p1AckedAt`). The Acknowledge action must also be available in the agent console.
- **Agent public reply** → email the client (with reply-by-portal link). **Client reply** → notify assignee in-app + email.
- **SLA at risk / breached** → in-app + email to assignee and team lead.
- All jobs: idempotent, retries with exponential backoff, dead-letter logging.

## 10. Admin panel (`/admin`, Super Admin; Team Lead limited)

Same design language as the agent console: left section nav, tables with drag-to-reorder, edit in a side sheet, live preview of the New Ticket form when editing categories/fields.

Sections:
1. **Categories & Sub-types** — CRUD, reorder, default priority, routed team, icon, EN/AR labels, archive/restore.
2. **Custom fields** — types limited to: text, number, dropdown, multi-select, date, yes/no, asset ID. Required toggle. Assign to categories. Do **not** build a general form builder or conditional logic.
3. **Teams & members** — team email list, Teams webhook URL, members.
4. **SLA policies** — per priority.
5. **Business hours & holidays**.
6. **Escalation rules** — P1 chain, on-call user, delays, channels.
7. **Clients & sites** — organisations, contract type, AMC expiry, sites, account manager.
8. **Macros**.
9. **Email templates** — editable subject + body text with variables (`{{ticketNumber}}` etc.); layout stays in code.
10. **Help center** — FAQ articles EN/AR.
11. **Audit log** — read-only, filterable.

On save: write `AdminAuditLog`, invalidate Redis config cache, emit `config:updated` so open forms refresh.

## 11. Internationalisation (EN / AR)

- next-intl with `en` and `ar`; `dir="rtl"` for Arabic. Use Tailwind logical utilities only (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`) — no `ml/mr/pl/pr/left/right`.
- All config labels stored in both languages; fall back to English if Arabic is empty.
- Animations that slide horizontally must mirror in RTL.

## 12. Security & quality

- argon2 password hashing, httpOnly secure cookies, CSRF protection, rate limiting on auth and ticket creation, Helmet headers, strict CORS.
- File uploads: pre-signed S3 URLs, size limit 25 MB, allow-list MIME types (images, video, PDF, text/log, zip), filename sanitisation. Leave a hook for virus scanning.
- No secrets in the repo; `.env.example` documents every variable.
- Structured logging (pino) with request IDs; no PII in logs.
- Unit tests for SLA/business-hours maths, routing, permission checks, and the internal-note leak test. Playwright E2E for: client creates ticket → agent replies in realtime → client sees it; P1 creation triggers notifications.

## 13. Seed data (`pnpm db:seed`)

Categories → team → sub-types (default priority):
- Cybersecurity / SOC → SOC: Security alert / suspected incident (P1), Malware / ransomware (P1), Phishing report (P2), Unauthorised access / account compromise (P1), Firewall / VPN issue (P2), SIEM / SOAR alert or tuning (P3), Vulnerability / patch request (P3), Log source not reporting (P3)
- Network & Connectivity → NOC: Site / link down (P1), Slow network / packet loss (P2), Wi-Fi coverage or access (P3), Switch / router fault (P2), VLAN / IP / DNS / DHCP change (P4), Structured cabling / fibre fault (P3), New port activation (P4)
- Data Center & Servers → DC Ops: Server down / degraded (P1), Storage / backup failure (P2), Virtualisation issue (P2), Power / UPS alarm (P1), Cooling / environmental alarm (P1), Colocation / rack access (P4), Capacity request (P4)
- Cloud & IT Infrastructure → IT Service Desk: Cloud service outage (P1), Email / M365 issue (P2), Account / password / MFA (P3), Licensing (P4), Endpoint / laptop / printer (P3), Software installation (P4)
- CCTV & Video Surveillance → ELV Field: Camera offline (P2), Poor image / night vision (P3), NVR / VMS recording failure (P1), Footage retrieval (P3), Camera repositioning (P4), Video analytics fault (P3)
- Access Control & Intrusion → ELV Field: Card reader / door fault (P2), Card issue / cancellation (P3), Access rights change (P4), Turnstile / barrier / gate fault (P2), Intrusion alarm fault (P1), Visitor management (P4)
- Life Safety Systems → ELV Field: Fire alarm fault / false alarm (P1), PA / voice evacuation fault (P1), Emergency lighting (P2), Nurse call / intercom (P1), Civil Defence inspection support (P3)
- Building Automation & Smart Building → BMS: BMS alarm / point offline (P2), HVAC control (P2), Lighting control (P3), Energy metering (P4), IoT sensor / integration fault (P3)
- Audio Visual → AV: Meeting room AV (P2), Video conferencing room (P2), Display / video wall (P3), Sound system (P3), Digital signage (P4)
- Software & Applications → Software: Bug / error (P3), Feature / change request (P4), Integration / API failure (P2), Performance issue (P3), Application access (P3)
- Service Requests & Commercial → Account Management: New installation / expansion, Site survey, Quotation / RFQ, AMC / warranty query, Preventive maintenance scheduling, Training request, Documentation / as-builts (all P4)
- Other → Triage: Describe below (P3)

Custom fields: Camera ID (CCTV), Door / reader number (Access Control), Panel / zone (Life Safety), Server hostname (Data Center), Room name (Audio Visual).

SLA: P1 15 min / 4 h (24/7) · P2 1 h / 8 h (24/7) · P3 4 h / 2 business days · P4 1 business day / 5 business days. Business hours Sun–Thu 07:30–16:30 Asia/Qatar.

Demo orgs/users and tickets matching the design (QNB, Hamad Medical Corporation, Ooredoo, Ministry of Interior; agents Maya Ruiz – SOC, Theo Kim – NOC, Priya Shah – ELV Field, Sam Okafor – IT Service Desk; one Super Admin). Seed Arabic labels for all categories and sub-types.

## 14. Phases (stop after each for approval)

1. **Foundation** — monorepo, Docker Compose, Prisma schema + migrations + seed, auth (client + staff, roles), design tokens + app shell for portal and console, EN/AR + RTL. *Done when:* both logins work and route correctly; `pnpm dev` runs cleanly from a fresh clone following the README.
2. **Tickets & chat** — New Ticket modal driven by DB config (dependent sub-type, auto-priority, P1 banner, Security Incident behaviour, custom fields, attachments), My tickets, ticket thread, agent Inbox/queue/thread/right panel, Socket.IO realtime chat, internal notes, status/priority/assignee changes with optimistic UI and animations. *Done when:* the E2E realtime flow passes and the internal-note leak test passes.
3. **SLA & notifications** — SLA calculation with business hours/holidays, SLA worker, email templates via Mailpit, Teams webhook, SMS provider, P1 acknowledge + escalation chain, daily P4 digest, in-app notifications. *Done when:* a P1 ticket produces email + Teams + SMS log, and escalates if not acknowledged.
4. **Admin panel** — all eleven sections, audit log, live config refresh. *Done when:* adding a new category/sub-type/field in admin appears on an open New Ticket form without reload, and old tickets still render archived items.
5. **Views & reports** — Team queue with filters, Customers, Reports (open by category, P1 open, SLA breached, unassigned, avg first reply time), Help center.
6. **AWS readiness** — Dockerfiles, production env config (RDS, ElastiCache, S3, SES, SNS), migration run on deploy, health checks, a deployment guide in the README. Do not deploy — prepare only.

Start with Phase 1. Before coding, reply with a short plan for Phase 1 and any questions that block you.
