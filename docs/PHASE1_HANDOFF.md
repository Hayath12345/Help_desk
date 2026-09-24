# Phase 1 — handoff notes (read before continuing)

The product brief is [`docs/BUILD_SPEC.md`](BUILD_SPEC.md). It is built in 6 phases, and **after each phase you stop, summarise, and wait for the owner's approval**. The approved design is `design/Loons Help Desk_final.html`: a bundled prototype, so open it in a browser. Its readable source is the `__bundler/template` JSON inside the file.

## Where things stand (branch `phase-1-foundation`)

Phase 1 (Foundation) is built, reviewed by four independent reviewers, verified and fixed. The integration run was green:

- `turbo typecheck lint`: 13/13 tasks pass.
- Tests pass: shared 31, db 67, emails 26, api 171, web 261.
- `turbo build` passes.
- Playwright: 22/22 pass. This covers client, staff and admin sign-in and routing, security headers, and sign-up → email via Mailpit → confirm → /tickets.

A final security and UI re-review then found **5 more issues (below, section "Open items")**. Those, plus some clean-up, are what's left before the Phase 1 report.

### Decisions the owner already approved (don't re-ask)

- Staff sign in with Microsoft Entra ID only. There's a single "Sign in with Microsoft" button in the design's card layout, and the issuer must be tenant-specific. A **development-only** password form appears when `AUTH_DEV_STAFF_LOGIN=true` and `NODE_ENV` is not production. Entra and Google credentials don't exist yet.
- Client self-sign-up is matched to an organisation by `Organization.emailDomains`. An unmatched domain gives a `PENDING_APPROVAL` account. Clients must also **verify their email** (link, 24 h, single use, click-to-confirm POST) before they can see any org data.
- Ticket numbers are `LG-<n>`. The sequence starts at 1001, and the seed moves it to 4834. The locale lives in the `NEXT_LOCALE` cookie (no URL prefix) and is synced to the user profile.

### Architecture in one paragraph

- `apps/web` (Next.js 16, Auth.js v5 beta, next-intl, Tailwind 4, shadcn/Radix) never touches the DB. Everything goes through `apps/api` (Fastify 5 + zod + Socket.IO + BullMQ worker in `src/worker.ts`).
- The web server calls `/internal/*` routes with `x-internal-api-key` and `x-client-ip`.
- Web-to-API calls use short-lived HS256 tokens minted by the web (`sub`, `role`, `sv`). The API reloads the user on every request (Redis cache ≤ 30 s).
- `User.sessionVersion` revokes all tokens, sockets and sessions. It is bumped by password reset and by Google-linking an unverified account.
- Permissions live in `packages/shared/src/permissions.ts`. `isActive()` = status ACTIVE and, for clients, email verified.
- Shared env parsers are in `packages/shared/src/env.ts`.
- Design tokens are in `packages/ui/src/tokens.css` and `tokens.ts` (keep them in sync; a test checks). ESLint forbids hex colours and left/right-specific (non-logical) Tailwind classes in `.tsx`.
- The Prisma 7 schema and migrations are in `packages/db`; the seed is idempotent and create-only.

### Local setup (Linux / cloud)

1. Install Node 24 and pnpm 12 (`npm i -g pnpm@12`), and Docker if available.
2. Copy the env file:
   ```bash
   cp .env.example .env
   ```
3. Replace `AUTH_SECRET`, `API_JWT_SECRET` and `INTERNAL_API_KEY` with random values; the apps refuse placeholders. To generate one:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
4. Start the services:
   ```bash
   docker compose up -d
   ```
   This starts Postgres 16, Redis 7, MinIO and Mailpit. Without Docker, run Postgres + Redis + Mailpit natively on the same ports.
5. Install, migrate and seed:
   ```bash
   pnpm install
   ```
   ```bash
   pnpm db:deploy
   ```
   ```bash
   pnpm db:seed
   ```
   Demo data needs `SEED_DEMO_DATA=true`, which `.env.example` already sets.
6. Install the Playwright browser:
   ```bash
   pnpm --filter @loons/web exec playwright install --with-deps chromium
   ```
7. Run the stack (web :3000, API :4000, worker):
   ```bash
   pnpm dev
   ```
8. Run the checks:
   ```bash
   pnpm typecheck && pnpm lint && pnpm test && pnpm build
   ```
   With the stack running:
   ```bash
   pnpm test:e2e
   ```
9. Demo password `LoonsDemo2026`; the accounts are in README.md.
10. Two gotchas:
    - Prisma 7 refuses `prisma migrate reset` when run by an AI agent. Don't bypass it; use `migrate dev` / `db:deploy`, or drop and recreate the database with psql.
    - Repeated E2E runs hit the sign-in and sign-up rate limits. Clear them with:
      ```bash
      docker compose exec redis sh -c "redis-cli --scan --pattern 'loons:rl*' | xargs -r redis-cli del"
      ```

## Open items (do these, in order)

### 1. RR-SEC-1 (medium): pre-hijacking still possible via the confirm link

**Attack:**

1. The attacker registers `victim@<client-domain>` with the attacker's password.
2. The victim receives a genuine verification email and clicks Confirm on the public `/verify-email/confirm` page, signed out. The account becomes verified.
3. The victim later uses "Continue with Google". `linkAndTouch` in `apps/api/src/services/auth.service.ts` only clears the password and revokes sessions when `emailVerifiedAt IS NULL`, so here it just links.

The attacker keeps password access and valid tokens to the victim's account and org.

**Fix (do both):**

- (a) Accept a confirm link only inside the registrant's own signed-in session. When nobody or a different user is signed in, show "Sign in to confirm this address" (with the address shown) instead of verifying. A mailbox owner who doesn't know the password then goes through forgot-password, which already replaces the password and bumps `sessionVersion`.
- (b) When Google is **first** linked to an account that has a password, always clear `passwordHash`, apply `REVOKE_SESSIONS_DATA` + `sessions.sessionsRevoked(userId)`, and queue an "A Google sign-in was added to your account" email (new template key, EN + AR, seeded + built-in default).

Add an `oauth.test.ts` case covering register → verify via link → Google link, plus web tests for the confirm-page states.

### 2. RR-SEC-2 (low): `TRUSTED_PROXY_HOPS=0` collapses all per-IP auth limits into one site-wide bucket

With hops=0 the web sends no `x-client-ip`, and the API's `clientIp()` in `apps/api/src/lib/internal-auth.ts` falls back to the web server's address. Any client can then exhaust `login:ip` / `register:ip` / … for everyone.

**Fix:** when an internal caller sends no valid `x-client-ip`, the IP-keyed rule keys return `null` (`limitGuard` already skips null keys). Keep the per-email and per-user rules. Add generous IP-independent global caps on register, verify and resend. Also refuse `TRUSTED_PROXY_HOPS=0` when `NODE_ENV=production` (fail loudly at web startup). Correct the `.env.example` comment for `TRUSTED_PROXY_HOPS` to match.

### 3. RR-SEC-3 (low): the seed treats an unset `NODE_ENV` as non-production

`packages/db/prisma/seed-data/options.ts` `seedOptions()` should seed demo data only when `NODE_ENV` is **explicitly** `development` or `test` **and** `SEED_DEMO_DATA` parses true. Make `packages/db`'s `db:seed` script set `NODE_ENV=development` (dotenv-cli `-v`, like `apps/api`'s dev scripts) so local seeding keeps working, and update the tests.

Fix the `.env.example` comment on `SEED_DEMO_DATA` to explain how production is detected.

### 4. UI-RR-1 (low): buttons lose keyboard focus while pending

`apps/web/components/auth/submit-button.tsx` sets `disabled` while pending, so focus drops to `<body>`. This affects "Resend email" on `/verify-email` and "Confirm" on `/verify-email/confirm`.

**Fix:** while pending, use `aria-disabled` + `aria-busy` and block double submits in the handler, as `LanguageToggle` already does. For the permanent invalid-token state in `ConfirmEmailForm`, render the invalid-link card (title + "Request a new link") instead of a disabled button, or move focus to the link. Add a component test that the pending button keeps focus.

### 5. UI-RR-2 (low): Arabic product name in the built-in email defaults

`packages/emails/src/defaults.ts` Arabic subject/body for `PASSWORD_RESET` and `EMAIL_VERIFICATION` still say "Loons Help Desk". Use `مكتب دعم لونز`, as the seed and the app do. The Latin wordmark stays only in `theme.ts` brand/footer. Add a test that no Arabic subject or body in `DEFAULT_EMAIL_TEMPLATES` or the seeded templates contains "Loons Help Desk".

### 6. Clean-up

- **TOOL-1:** run `pnpm format` repo-wide (Prettier, `printWidth` 100) so `pnpm format:check` passes. `apps/api` currently uses a wider style, so this reformats many API files. That's expected; do it in its own commit ("Format repo with Prettier").
- **E2E teardown:** each `pnpm test:e2e` run leaves one verified `e2e-<timestamp>@hamad.qa` client in the Hamad org (`apps/web/e2e/verify-email.spec.ts`).
  - Add a small `packages/db` script (e.g. `scripts/cleanup-e2e.ts`, run via `pnpm --filter @loons/db exec tsx …`) that deletes users matching `e2e-%@hamad.qa` and `pending.%@unmatched-e2e.test`, and their dependent rows.
  - Call it from a Playwright `globalTeardown`.
- **Docs** (README / `.env.example`):
  - **Troubleshooting, "Too many attempts":** list the current limits:
    - sign-in 10 per 15 min per IP + email, 50 per IP, and 30 per hour per email (successful sign-ins count too);
    - forgot-password 5 per hour per email;
    - sign-up 5 per hour per IP;
    - resend verification 3 per 15 min per user.
  - **`pnpm test:e2e` prerequisites:** Mailpit plus the API worker (Playwright starts its own worker and reuses a running API/web). `MAILPIT_API_URL` overrides the Mailpit API address.
  - **`.env.example`:** `API_TOKEN_TTL_SECONDS` must be 60–3600 (both apps refuse other values). Boolean vars accept true/1/yes/on or false/0/no/off, and anything else stops the app.
  - **README Authentication:** sockets also close when their access token expires, and the confirm link requires a click on Confirm (mail scanners can't verify an address).
  - **Deployment note for Phase 6:** use `node .next/standalone/apps/web/server.js`, and note that the web prints "Ready" before its config check can exit with `[config] …`.
- **Optional:** move `WEB_ROUTES.verifyEmailConfirm = '/verify-email/confirm'` and the `verifyEmailSchema` / `resendVerificationSchema` zod schemas into `@loons/shared`, and use them from both apps.

### 7. Final verification, commit and report

1. Run the full check set (step 8 of the local setup) including E2E, and re-run the RR probes as tests.
2. Commit on `phase-1-foundation` with messages ending in `Co-Authored-By: …`, then push to `origin phase-1-foundation`.
3. Write the **Phase 1 summary** for the owner, covering:
   - what was built;
   - how to run and test it;
   - demo accounts;
   - deviations from the design or spec, and why;
   - known limitations and Phase 2 carry-overs (below).
4. **Stop and wait for approval** before starting Phase 2.

## Carry-overs for Phase 2

- **Email templates:** every non-URL template variable is rendered on one line and never becomes a link (`packages/emails`, SEC-7). Multi-line variables (`messageBody`, `description`, `ticketList`) need a "block variable" list that keeps paragraphs but is still never linkified.
- **Browser socket client:** it must refetch a token and reconnect on `disconnect`, because the server now closes sockets on token expiry and revocation. Only `ACTIVE` + verified users may connect (others get `FORBIDDEN`).
- **Admin changes:** after changing a user's role, status, org or teams, call `app.services.sessions.revokeUserSessions()` or `principals.invalidate(userId)`.
- **Rate-limit key names:** keys from `limitGuard` are named `loons:rl:undefinedundefined-<rule>:…`, because `@fastify/rate-limit` `createRateLimit` passes an empty route. This is cosmetic; the `loons:rl*` reset pattern still matches.
- **Flaky API test:** one unexplained API-test failure was seen once in about 15 full runs and never reproduced. Watch for flakes in `apps/api/test/rate-limit.test.ts` and `socket.test.ts`.
