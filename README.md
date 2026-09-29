# Loons Help Desk

Ticketing and support platform for **Loons Group** clients (government, banking, healthcare, oil & gas).
Clients raise tickets about systems Loons installed or manages; Loons staff triage, chat with clients and resolve them.

- **Client portal** — sign in (email/password or Google), My tickets, Help center, English/Arabic.
- **Agent console** — Inbox, Team queue, Customers, Reports for Loons engineers and SOC analysts (Microsoft Entra ID sign-in).
- **Admin panel** — configuration for Super Admins (Team Leads get a limited view).

The UI follows the approved design in [`design/Loons Help Desk_final.html`](design/Loons%20Help%20Desk_final.html) (open it in a browser).

> **Status:** Phase 2 (Tickets & chat) — on top of the Phase 1 foundation (monorepo, infrastructure, schema + seed,
> authentication, design tokens, EN/AR + RTL shells): the New ticket modal driven by the database configuration, My
> tickets and the ticket thread for clients, the agent Inbox with conversation, internal notes and the right panel,
> attachments through pre-signed uploads, and realtime chat over Socket.IO. SLA worker + notifications, admin, reports
> and AWS packaging arrive in phases 3–6. Handoff notes: [`docs/PHASE2_HANDOFF.md`](docs/PHASE2_HANDOFF.md).

---

## Stack

| Layer       | Choice                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo    | pnpm 12 workspaces + Turborepo, TypeScript (strict) everywhere                                                                          |
| Web         | Next.js 16 (App Router, Turbopack), Tailwind CSS 4, shadcn/ui (Radix), Motion, TanStack Query, React Hook Form + Zod, next-intl (EN/AR) |
| API         | Fastify 5 (REST) + Zod + OpenAPI (`/docs`), Socket.IO (Redis adapter)                                                                   |
| Jobs        | BullMQ + Redis (separate worker process)                                                                                                |
| Database    | PostgreSQL 16 + Prisma 7 (migrations committed)                                                                                         |
| Auth        | Auth.js v5 in the web app — clients: email/password (argon2id) + Google; staff: Microsoft Entra ID. Short-lived JWTs for API + socket   |
| Files       | S3-compatible storage (MinIO locally, S3 on AWS) via AWS SDK v3                                                                         |
| Email / SMS | React Email templates → SMTP (Mailpit) locally / SES on AWS · SMS console logger locally / SNS on AWS                                   |
| Tests       | Vitest (unit/integration), Playwright (E2E)                                                                                             |

## Repository layout

```
loons-helpdesk/
├─ apps/
│  ├─ web/          Next.js client portal + agent console + admin panel
│  └─ api/          Fastify REST + Socket.IO (src/server.ts) and BullMQ worker (src/worker.ts)
├─ packages/
│  ├─ db/           Prisma schema, migrations, seed, Prisma client + password hashing
│  ├─ shared/       Zod schemas, enums, permissions (RBAC), routes, ticket-number helpers
│  ├─ emails/       React Email layout + template rendering
│  ├─ ui/           Design tokens (tokens.css for Tailwind, tokens.ts for emails)
│  └─ eslint-config Shared ESLint config + custom rules (RTL-safe classes, no hex colours)
├─ design/          Approved design prototype
├─ docker-compose.yml   postgres, redis, minio (+ bucket init), mailpit
└─ .env.example     every environment variable, documented
```

---

## Getting started (local)

### Prerequisites

- **Node.js 24.16 or newer** (the current 24 LTS is recommended). On Windows, Node 24.15 and older crash now and then
  with `0xC0000409` on local TCP connections (a libuv bug fixed in Node 24.16.0); see the Windows note under Scripts.
- **pnpm 12** — `npm i -g pnpm@12` (or `corepack enable pnpm`)
- **Docker Desktop** (with Docker Compose)

> **Windows**
>
> - Clone to a **short path** (for example `C:\src\loons-helpdesk`). pnpm writes files with ~130-character names under
>   `node_modules`, so a deep folder (OneDrive, long user paths) exceeds the 260-character limit and every `pnpm`
>   script fails with `os error 3`. Alternatively enable long paths (`LongPathsEnabled=1`) and run
>   `git config --system core.longpaths true`.
> - If `docker` is not found in Git Bash after installing Docker Desktop, open a new terminal or add
>   `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` to your PATH.

### 1. Configure environment

```bash
cp .env.example .env
```

Replace the three `replace-me…` secrets (`AUTH_SECRET`, `API_JWT_SECRET`, `INTERNAL_API_KEY`) with random values —
the apps refuse to start while they are placeholders:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Everything else works as-is for local development.

### 2. Start infrastructure

```bash
docker compose up -d
```

| Service               | URL                                                                               |
| --------------------- | --------------------------------------------------------------------------------- |
| PostgreSQL            | `localhost:5432` (loons / loons)                                                  |
| Redis                 | `localhost:6379`                                                                  |
| MinIO (S3)            | API `localhost:9000` · console http://localhost:9001 (loons / loons-local-secret) |
| Mailpit (email inbox) | http://localhost:8025                                                             |

### 3. Install, migrate, seed

```bash
pnpm install        # also generates the Prisma client
pnpm db:migrate     # applies migrations (prisma migrate dev)
pnpm db:seed        # configuration + demo data (idempotent; demo data needs SEED_DEMO_DATA=true, set in .env.example —
                    # the script defaults NODE_ENV to development; any other NODE_ENV never seeds demo data)
```

### 4. Run everything

```bash
pnpm dev
```

This starts the **web app** (http://localhost:3000), the **API** (http://localhost:4000, OpenAPI docs at http://localhost:4000/docs) and the **worker**.

### Demo accounts

All demo accounts use the password **`LoonsDemo2026`** (`SEED_DEMO_PASSWORD`).

| Role                                                                                  | Email                                                        | Signs in at    | Lands on         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------- | ---------------- |
| Client — Hamad Medical Corporation                                                    | `aisha.alkuwari@hamad.qa`                                    | `/login`       | `/tickets`       |
| Client — QNB                                                                          | `khalid.mansouri@qnb.com`                                    | `/login`       | `/tickets`       |
| Client — Ooredoo                                                                      | `f.alsulaiti@ooredoo.qa`                                     | `/login`       | `/tickets`       |
| Client — Ministry of Interior (Arabic UI)                                             | `o.alnaimi@moi.gov.qa`                                       | `/login`       | `/tickets`       |
| Agent — SOC                                                                           | `maya.ruiz@loonsgroup.com`                                   | `/staff/login` | `/console/inbox` |
| Agent — NOC, DC Ops                                                                   | `theo.kim@loonsgroup.com`                                    | `/staff/login` | `/console/inbox` |
| Agent — ELV Field, BMS, AV                                                            | `priya.shah@loonsgroup.com`                                  | `/staff/login` | `/console/inbox` |
| Agent — IT Service Desk, Software, Triage                                             | `sam.okafor@loonsgroup.com`                                  | `/staff/login` | `/console/inbox` |
| Agent — Account Management (account managers)                                         | `rashid.hamdan@loonsgroup.com`, `lina.haddad@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Team Lead — SOC, NOC, DC Ops                                                          | `karim.nasser@loonsgroup.com`                                | `/staff/login` | `/console/inbox` |
| Team Lead — ELV Field, BMS, AV, IT Service Desk, Software, Account Management, Triage | `hana.yousef@loonsgroup.com`                                 | `/staff/login` | `/console/inbox` |
| Super Admin (operations manager)                                                      | `noor.alkaabi@loonsgroup.com`                                | `/staff/login` | `/admin`         |

Staff normally sign in with **Microsoft Entra ID**. Until Entra is configured, the staff page shows a
**development-only** password form (`AUTH_DEV_STAFF_LOGIN=true`; always disabled when `NODE_ENV=production`).

---

## Scripts

| Command                                  | What it does                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                               | web + API + worker in watch mode                                                           |
| `pnpm build`                             | production build of every package                                                          |
| `pnpm typecheck` / `pnpm lint`           | TypeScript and ESLint across the repo                                                      |
| `pnpm format` / `pnpm format:check`      | Prettier (write / verify) across the repo                                                  |
| `pnpm test`                              | unit + integration tests (needs `docker compose up`; see the Windows note below)           |
| `pnpm test:e2e`                          | Playwright E2E (see [End-to-end tests](#end-to-end-tests))                                 |
| `pnpm db:migrate`                        | create/apply migrations in development                                                     |
| `pnpm db:deploy`                         | apply committed migrations (CI / production)                                               |
| `pnpm db:seed`                           | seed configuration + demo data (idempotent)                                                |
| `pnpm db:reset`                          | drop the database, re-apply migrations and re-seed                                         |
| `pnpm db:studio`                         | Prisma Studio                                                                              |
| `pnpm --filter @loons/db db:cleanup-e2e` | delete the accounts, tickets and stored files E2E runs create (runs after `pnpm test:e2e`) |

> **Windows note on `pnpm test`:** with Node 24.15 or older, test workers (and occasionally the dev servers) die with
> `0xC0000409`. This is a libuv bug on Windows loopback TCP connections, fixed in Node 24.16.0
> ([libuv#5107](https://github.com/libuv/libuv/pull/5107)); it is not this code base. **Upgrade Node** to fix it.
> Until then `pnpm test` in `apps/api` runs `test/run-vitest.ts`, which re-runs a crashed file once, fails on
> anything else, and prints the upgrade hint. A crashed worker can leave `test-…` organisations/teams/categories and
> `t-<hex>@` users in the dev database; `docs/PHASE2_HANDOFF.md` (Testing notes) says how to remove them.

### End-to-end tests

- First time: `pnpm --filter @loons/web exec playwright install --with-deps chromium`.
- Needs Postgres, Redis, **MinIO** and **Mailpit** (`docker compose up -d`), migrated and seeded with demo data. The
  sign-up test reads the verification and reset emails from Mailpit's API (`MAILPIT_API_URL`, default
  `http://localhost:8025/api/v1`); the emails are sent by the **API worker**.
- The attachment tests (API suite and E2E) expect the bucket's upload-expiry lifecycle rule. A fresh
  `docker compose up -d` adds it; an existing local MinIO needs `docker compose up minio-init` once after pulling.
- Playwright reuses a running API (:4000) and web app (:3000) — e.g. from `pnpm dev` — or starts them, and always starts
  its own worker next to them (harmless: workers share the queues).
- Each run signs up one `e2e-<timestamp>@hamad.qa` client and raises tickets whose subject starts with
  `[e2e:<timestamp>]` as a seeded client; a global teardown deletes those accounts, tickets and their MinIO objects
  (`db:cleanup-e2e`), so don't run two E2E suites against the same database at once. A failed cleanup fails the run.
- The ticket spec opens two browser contexts: a client raises a ticket with an attachment, the agent sees it appear in
  the Inbox without reloading, replies publicly and adds an internal note, and the client sees the reply in realtime
  but never the note (page and network are both checked).

---

## Authentication

- **Clients** sign in with email + password (argon2id) or Google. Self-sign-up is matched to an organisation by
  email domain (`Organization.emailDomains`), but the account sees **nothing until the email address is verified**
  through the emailed link (24 h, single use) — otherwise anyone could type an address on a client's domain and read
  that organisation's tickets. An unmatched domain creates a _pending approval_ account that also sees nothing until
  an admin links it to an organisation.
- The confirmation link only confirms the address **inside that account's own signed-in session**, and only after a
  click on **Confirm** (a POST, so mail scanners that pre-fetch links can't verify an address). Opened signed out or
  as another account, it shows _Sign in to confirm this address_ instead; a mailbox owner who doesn't know the
  password uses _Forgot password_, which replaces it and signs out every other session.
- The first time **Google** is linked to an account that has a password, the password is removed, every existing
  session, API token and socket is revoked, and the owner is emailed (_Google sign-in was added to your account_):
  whoever chose that password may not own the mailbox.
- **Staff** (`@loonsgroup.com`, `STAFF_EMAIL_DOMAIN`) sign in with Microsoft Entra ID (tenant-specific issuer only);
  the staff account must exist in the database.
- The web app (Auth.js) keeps an encrypted session cookie and mints a **15-minute HS256 access token** for API and
  Socket.IO calls. The API re-loads the user from the database (cached ≤ 30 s), so role changes and disabled accounts
  take effect quickly. Every user has a _session version_: a password reset bumps it, which immediately invalidates
  all API tokens and open sockets and ends the web session at its next refresh (≤ 5 min). A socket also closes when
  the access token it connected with expires (clients fetch a new token and reconnect).
  Authorisation is enforced by the API — the UI only hides controls.
- Password reset links are emailed through the BullMQ worker (see Mailpit locally), expire after 30 minutes and are single-use.
- Sign-in, sign-up and reset are rate-limited per IP and per email (they fail closed if Redis is down). The web app
  sends security headers (CSP `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS in production),
  and the API uses Helmet and strict CORS. The apps refuse to start with the placeholder secrets from `.env.example`.

## Tickets & chat

- **Raising a ticket:** the New ticket modal is driven by the database configuration (categories → sub-types with a
  default priority, custom fields per category, sites of the requester's organisation, impact). A _Security incident_
  is locked to the Cybersecurity/SOC category and tagged `security`; P1 shows the 24/7 SOC banner. Staff raise tickets
  on behalf of a client (channel PHONE); the ticket is routed to the category's team. Numbers are `LG-<n>`.
- **Statuses:** NEW → OPEN → PENDING (waiting on the client) → SOLVED → CLOSED. A client reply reopens a ticket, a staff
  public reply sets PENDING (or SOLVED with _Send & solve_), an internal note on a NEW ticket makes it OPEN. Clients can
  only mark their tickets solved or reopen them; every change writes a `TicketEvent`.
- **SLA:** first-reply and resolution targets come from the priority's policy over the business calendar
  (`Asia/Qatar` business hours and holidays from the seed). PENDING pauses the resolution clock only; the first-reply
  clock never pauses. A priority change recomputes the targets and replays the ticket's pauses. The console sorts by
  SLA and shows the _SLA at risk_ view (remaining time under 1 hour or under half the window).
- **Conversation:** public replies and internal notes (staff only, yellow). Messages are delivered over Socket.IO to
  the ticket's room after the database commit; internal notes, staff typing and note attachments only ever reach the
  staff room. Sending is optimistic with retry; a reconnect catches up from the last known message.
- **Attachments:** allow-listed types (PDF, images, video, text/log files, zip), 25 MB per file and per message, 10
  files per message. The browser uploads straight to storage with a pre-signed POST (MinIO locally, S3 on AWS —
  `NEXT_PUBLIC_UPLOAD_ORIGIN` must be in the web CSP). On completion the API copies the checked object to a
  server-only key, verifies the file's magic bytes against its declared type, runs the virus-scan hook (a no-op
  placeholder until ClamAV / GuardDuty is plugged in) and serves only that copy through 5-minute signed download
  links. File names always end with an extension that matches the declared type (`Invoice.pdf.exe` becomes
  `Invoice.pdf.exe.pdf`); invisible and direction-control characters are removed and names are capped at 200 bytes.
- **Limits:** 30 new tickets and 60 pre-signed uploads per user per 10 minutes, 120 messages per minute. Realtime:
  a user may hold 20 sockets and a client address 500; new connections per address are limited (200 at once, then
  20/s) and so are connections still waiting for their handshake (50); a socket may join at most 50 ticket rooms;
  every packet and event is budgeted and floods are disconnected. The per-address and per-user numbers can be
  raised with the `REALTIME_*` variables in `.env.example` (a large office behind one NAT shares one address).
  Details: `docs/PHASE2_HANDOFF.md` → Realtime.
- **Macros:** team macros fill the composer (`{{requesterFirstName}}`, `{{siteName}}`) and can arm a status that is
  applied when the reply is sent.

### Enabling Google (clients)

Create an OAuth client (Web) in Google Cloud, add the redirect URI
`http://localhost:3000/api/auth/callback/google`, and set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

### Enabling Microsoft Entra ID (staff)

Register an app in Entra ID (single tenant), add the Web redirect URI
`http://localhost:3000/api/auth/callback/microsoft-entra-id`, create a client secret and set
`AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` and
`AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`.
Enforce MFA with Entra Conditional Access.

---

## Conventions

- **Design tokens** live in `packages/ui/src/tokens.css` (Tailwind theme) and `tokens.ts` (emails). Components use
  token classes (`bg-page`, `text-ink-muted`, `bg-status-open-bg`, `bg-p1-dot`, …) — ESLint rejects hex colours in `.tsx`.
- **RTL**: Arabic sets `dir="rtl"`. Use logical utilities only (`ms-/me-/ps-/pe-/inset-s-/inset-e-/border-s/border-e/text-start/text-end`) —
  ESLint rejects `ml-/mr-/pl-/pr-/left-/right-/text-left/…`. Horizontal animations take the direction into account.
- **i18n**: `apps/web/messages/{en,ar}/<namespace>.json`; English keys are type-checked; missing Arabic falls back to English.
- **Config records** are never hard-deleted — they are archived (`isActive = false`) and old tickets keep showing them.
- **Logs** are structured (pino) with request IDs and never contain PII.

## Troubleshooting

- **`ERR_PNPM_IGNORED_BUILDS`** — a new dependency wants to run an install script; approve it with
  `pnpm approve-builds <package>` (the allow-list lives in `pnpm-workspace.yaml` → `allowBuilds`).
- **Port already in use** — stop other processes on 3000/4000/5432/6379/9000/8025, or change the ports in `.env` / `docker-compose.yml`.
- **Do not set `NODE_ENV` in `.env`** — `next build` breaks with a development `NODE_ENV`.
- **`Too many attempts`** (often during repeated `pnpm test:e2e` runs) — locally every request comes from the same
  address, so the per-IP auth limits fill up quickly. The current limits:

  | Action                                          | Limits                                                                                                      |
  | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | Sign-in                                         | 10 per 15 min per IP + email · 50 per 15 min per IP · 30 per hour per email (successful sign-ins count too) |
  | Forgot password                                 | 5 per 15 min per IP + email · 5 per hour per email                                                          |
  | Sign-up                                         | 5 per hour per IP · 100 per hour for callers with an unknown IP                                             |
  | Resend verification email                       | 3 per 15 min per user · 10 per 15 min per IP · 100 per 15 min for unknown IPs                               |
  | Open / confirm a verification link              | 30 / 10 per 15 min per IP · 600 / 300 per 15 min for unknown IPs                                            |
  | Reset password (with a link)                    | 10 per 15 min per IP                                                                                        |
  | Google / Microsoft sign-in (after the provider) | 60 per 15 min per IP                                                                                        |

  Per-IP limits only apply when the web app knows the client IP (`TRUSTED_PROXY_HOPS` ≥ 1). With `0` (development
  only) they are skipped: the per-email and per-user limits and the shared unknown-IP caps apply, and resetting a password with a link or
  finishing a Google / Microsoft sign-in is then not rate limited. Wait for the window to pass or clear
  the counters: `docker compose exec redis sh -c "redis-cli --scan --pattern 'loons:rl*' | xargs -r redis-cli del"`.

- **`os error 3` from every pnpm script on Windows** — the repository path is too long; see the Windows note under Prerequisites.
- **Uploads fail in the browser** — the upload goes straight to MinIO: check that `NEXT_PUBLIC_UPLOAD_ORIGIN` matches
  `S3_ENDPOINT` as the browser sees it and that the `minio-init` container finished (`docker compose logs minio-init`
  ends with `bucket ready`). _"The file's content doesn't match its type"_ means the bytes are not what the file
  extension says (for example a JPEG renamed `.png`); rename the file to its real type.
- **A test worker exited with `0xC0000409`** — see the Windows note under Scripts; run `pnpm test` again.

---

## Deployment notes (prepared in Phase 6)

- The web app builds as a Next.js **standalone** server: after `pnpm build`, run
  `node .next/standalone/apps/web/server.js` (with `.next/static` copied next to it, as the Phase 6
  Dockerfile will do).
- The web server prints `Ready` **before** its configuration check has finished: a bad configuration (placeholder
  secrets, `TRUSTED_PROXY_HOPS=0` in production, …) then exits the process with a `[config] …` line. Health checks
  should therefore probe a page, not just wait for the log line.
- Seed production with `NODE_ENV=production` set (`pnpm db:seed` only defaults `NODE_ENV` to development when it is
  unset, so an explicit production value never gets demo data).
- **Attachments bucket:** private and unversioned; CORS must allow `POST` from the web origin; a lifecycle rule
  expires the transient `attachments/` prefix after 1 day (confirmed files live under `files/` and must not expire).
  `docker-compose.yml` sets this up for MinIO; the S3 lifecycle JSON and the IAM actions the API needs are in
  `docs/PHASE2_HANDOFF.md` → Deployment notes. Plug a real scanner into the API's `scanHook` before go-live.
- **Several API instances** need `SOCKET_REDIS_ADAPTER=true`; socket limits are per instance, and a ticket update
  waits at most about 1 s for the other instances.
