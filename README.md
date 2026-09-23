# Loons Help Desk

Ticketing and support platform for **Loons Group** clients (government, banking, healthcare, oil & gas).
Clients raise tickets about systems Loons installed or manages; Loons staff triage, chat with clients and resolve them.

- **Client portal** — sign in (email/password or Google), My tickets, Help center, English/Arabic.
- **Agent console** — Inbox, Team queue, Customers, Reports for Loons engineers and SOC analysts (Microsoft Entra ID sign-in).
- **Admin panel** — configuration for Super Admins (Team Leads get a limited view).

The UI follows the approved design in [`design/Loons Help Desk_final.html`](design/Loons%20Help%20Desk_final.html) (open it in a browser).

> **Status:** Phase 1 (Foundation) — monorepo, local infrastructure, database schema + seed, authentication and role routing, design tokens, EN/AR + RTL app shells. Tickets, chat, SLA, notifications, admin, reports and AWS packaging arrive in phases 2–6.

---

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm 12 workspaces + Turborepo, TypeScript (strict) everywhere |
| Web | Next.js 16 (App Router, Turbopack), Tailwind CSS 4, shadcn/ui (Radix), Motion, TanStack Query, React Hook Form + Zod, next-intl (EN/AR) |
| API | Fastify 5 (REST) + Zod + OpenAPI (`/docs`), Socket.IO (Redis adapter) |
| Jobs | BullMQ + Redis (separate worker process) |
| Database | PostgreSQL 16 + Prisma 7 (migrations committed) |
| Auth | Auth.js v5 in the web app — clients: email/password (argon2id) + Google; staff: Microsoft Entra ID. Short-lived JWTs for API + socket |
| Files | S3-compatible storage (MinIO locally, S3 on AWS) via AWS SDK v3 |
| Email / SMS | React Email templates → SMTP (Mailpit) locally / SES on AWS · SMS console logger locally / SNS on AWS |
| Tests | Vitest (unit/integration), Playwright (E2E) |

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

- **Node.js 24+**
- **pnpm 12** — `npm i -g pnpm@12` (or `corepack enable pnpm`)
- **Docker Desktop** (with Docker Compose)

> Windows: if `docker` is not found in Git Bash after installing Docker Desktop, open a new terminal or add
> `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` to your PATH.

### 1. Configure environment

```bash
cp .env.example .env
```

Replace the three `replace-me…` secrets (`AUTH_SECRET`, `API_JWT_SECRET`, `INTERNAL_API_KEY`) with random values:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Everything else works as-is for local development.

### 2. Start infrastructure

```bash
docker compose up -d
```

| Service | URL |
|---|---|
| PostgreSQL | `localhost:5432` (loons / loons) |
| Redis | `localhost:6379` |
| MinIO (S3) | API `localhost:9000` · console http://localhost:9001 (loons / loons-local-secret) |
| Mailpit (email inbox) | http://localhost:8025 |

### 3. Install, migrate, seed

```bash
pnpm install        # also generates the Prisma client
pnpm db:migrate     # applies migrations (prisma migrate dev)
pnpm db:seed        # configuration + demo data (idempotent: safe to re-run)
```

### 4. Run everything

```bash
pnpm dev
```

This starts the **web app** (http://localhost:3000), the **API** (http://localhost:4000, OpenAPI docs at http://localhost:4000/docs) and the **worker**.

### Demo accounts

All demo accounts use the password **`LoonsDemo2026`** (`SEED_DEMO_PASSWORD`).

| Role | Email | Signs in at | Lands on |
|---|---|---|---|
| Client — Hamad Medical Corporation | `aisha.alkuwari@hamad.qa` | `/login` | `/tickets` |
| Client — QNB | `khalid.mansouri@qnb.com` | `/login` | `/tickets` |
| Client — Ooredoo | `f.alsulaiti@ooredoo.qa` | `/login` | `/tickets` |
| Client — Ministry of Interior (Arabic UI) | `o.alnaimi@moi.gov.qa` | `/login` | `/tickets` |
| Agent — SOC | `maya.ruiz@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Agent — NOC, DC Ops | `theo.kim@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Agent — ELV Field, BMS, AV | `priya.shah@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Agent — IT Service Desk, Software, Triage | `sam.okafor@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Agent — Account Management (account managers) | `rashid.hamdan@loonsgroup.com`, `lina.haddad@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Team Lead — SOC, NOC, DC Ops | `karim.nasser@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Team Lead — ELV Field, BMS, AV, IT Service Desk, Software, Account Management, Triage | `hana.yousef@loonsgroup.com` | `/staff/login` | `/console/inbox` |
| Super Admin (operations manager) | `noor.alkaabi@loonsgroup.com` | `/staff/login` | `/admin` |

Staff normally sign in with **Microsoft Entra ID**. Until Entra is configured, the staff page shows a
**development-only** password form (`AUTH_DEV_STAFF_LOGIN=true`; always disabled when `NODE_ENV=production`).

---

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | web + API + worker in watch mode |
| `pnpm build` | production build of every package |
| `pnpm typecheck` / `pnpm lint` | TypeScript and ESLint across the repo |
| `pnpm test` | unit + integration tests (needs `docker compose up`) |
| `pnpm test:e2e` | Playwright E2E (first time: `pnpm --filter @loons/web exec playwright install chromium`) |
| `pnpm db:migrate` | create/apply migrations in development |
| `pnpm db:deploy` | apply committed migrations (CI / production) |
| `pnpm db:seed` | seed configuration + demo data (idempotent) |
| `pnpm db:reset` | drop the database, re-apply migrations and re-seed |
| `pnpm db:studio` | Prisma Studio |

---

## Authentication

- **Clients** sign in with email + password (argon2id) or Google. Self-sign-up is matched to an organisation by
  email domain (`Organization.emailDomains`); an unmatched domain creates a *pending approval* account that sees
  nothing until an admin links it to an organisation.
- **Staff** (`@loonsgroup.com`, `STAFF_EMAIL_DOMAIN`) sign in with Microsoft Entra ID; the staff account must exist in the database.
- The web app (Auth.js) keeps an encrypted session cookie and mints a **15-minute HS256 access token** for API and
  Socket.IO calls. The API re-loads the user from the database on every request, so role changes and
  disabled accounts take effect immediately. Authorisation is enforced by the API — the UI only hides controls.
- Password reset links are emailed through the BullMQ worker (see Mailpit locally), expire after 30 minutes and are single-use.

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
