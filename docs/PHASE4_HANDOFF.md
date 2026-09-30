# Phase 4 — handoff notes (admin panel)

Read [`PHASE3_HANDOFF.md`](PHASE3_HANDOFF.md) and [`PHASE2_HANDOFF.md`](PHASE2_HANDOFF.md) first. The Phase 4 build
contract is [`PHASE4_CONTRACT.md`](PHASE4_CONTRACT.md); its decisions E1–E20 hold as written, except where this file
says "as built".

## Where things stand

Phase 4 is built on top of Phase 3. Two foundation lanes (API plumbing, web admin kit) and four section lanes built
it, three adversarial verifiers (authorization, data integrity, UI) tried to break it, and an integrator fixed all 17
gaps they found. An independent review of the whole Phase 4 change then ran eleven reviewers (one per area plus a
contract-compliance audit) with a skeptic re-checking every finding: 43 of 46 findings held (2 high, 10 medium, 31
low). Six fix lanes fixed all of them plus two UI points from the screenshots, independent verifiers re-checked each
lane, and a second integration closed their follow-ups. Every fix has a regression test and a mutation check.

**Done-when:** a client has the New Ticket form open; the Super Admin creates a category with its first sub-type and
a custom field linked to it; the open form shows them without a reload; the client raises a ticket with them; the
admin archives them; the ticket still renders them with an "archived" marker in the portal header and the console
panel (`apps/web/e2e/admin.spec.ts`, two browser contexts, plus the API suites `admin-categories-archived-refs` and
`ticket-archived-refs`).

### What was built

- **Data** — one migration, `20260929114726_phase4_admin`: `AuditAction` += `DELETE`, `APPROVE`, `REJECT`;
  `AdminAuditLog.entityLabel` and `requestId` with indexes on `(action, createdAt)` and `(entity, createdAt)`;
  `Category.assetPlaceholderAr`; `updatedAt` on `Holiday` and `BusinessHours` (for stale-edit checks). Custom-field
  options keep living in `CustomField.options` (JSON) with an `isActive` per option.
- **Shared** (`packages/shared`) — the 13 admin sections in nav order with their groups (`ADMIN_SECTIONS`,
  `ADMIN_SECTION_GROUP`), the Team Lead and staff rules (`permissions.ts`), zod contracts for every section in
  `schemas/admin/*.ts`, the numeric form-config `version` and `businessDayMinutes`, `isActive` on the ticket's
  category / sub-type / team / site and on custom-field values (with option labels), `escalationTeamWarnings`.
- **API** — 79 routes under `/admin/*` (OpenAPI tag `admin`), one plugin per section, plus
  `GET /admin/staff-directory` for pickers. Shared plumbing in `apps/api/src/services/admin/`: the admin writer
  (audit rows in the same transaction, `config:updated` after commit), row locks and `expectedUpdatedAt` checks,
  the reorder helper, key generation, Prisma error mapping (`apps/api/src/lib/prisma-errors.ts`), the
  generation-guarded form-config cache (`ticket-config.service.ts`).
- **Worker** — escalation steps re-check their timing when they fire and follow reorders (E13); the SLA scan
  reschedules the digest and retention jobs after a time-zone or digest-time change (E11).
- **Web** — the admin shell at `/admin` (grouped left nav, overview), the kit in `components/admin/kit/`
  (`AdminTable`, `AdminSheet`, `BilingualField`, `LanguageSwitch`, `ReorderList`, `KeyField`, `WhoCanSeeNote`,
  `ArchivedBadge`, `ConfirmDialog`, `InlineEditor`), one folder per section in `components/admin/sections/`, live
  refresh (`lib/realtime/config-scopes.ts`, `lib/tickets/config-version.ts`), the E16 New Ticket preview, archived
  markers and custom-field values on old tickets (console panel, portal header).

### Sections as built

| Group            | Section                   | Super Admin                                                                                     | Team Lead                                            |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Ticket setup     | Categories & sub-types    | Create (with the first sub-type), edit, archive / restore, reorder, link fields, live preview   | —                                                    |
|                  | Custom fields             | Types per spec §10.2, options archived one at a time, link to categories and order per category | —                                                    |
|                  | Macros                    | Global and team macros                                                                          | Their teams' macros only (never global, never moved) |
| SLA & escalation | SLA policies              | Hours + minutes per target, business-hours flag, `atRiskPercent` (1–99)                         | —                                                    |
|                  | Business hours & holidays | HH:mm per weekday (at least one open day), holidays with archive / restore                      | —                                                    |
|                  | Escalation rules          | P1 chains, global and per team: target, delay, channels; warnings for missing webhook / on-call | —                                                    |
| People & clients | Teams & members           | Names, email list, Teams webhook (write-only), members and roles, on-call user, archive         | Members and on-call of teams they lead               |
|                  | Staff                     | Create (Microsoft sign-in links on first use), name, job title, phone, role, status             | —                                                    |
|                  | Clients & sites           | Organisations, email domains, sites, pending and rejected sign-ups                              | —                                                    |
| Communication    | Email templates           | The 12 fixed keys, English \| العربية switch, live preview, Reset to default                    | —                                                    |
|                  | Help center               | Articles EN/AR, publish / unpublish, archive / restore, reorder, preview                        | —                                                    |
| System           | General settings          | Time zone, SOC phone, auto-close days, P4 digest time, security category                        | —                                                    |
|                  | Audit log                 | Read-only, filter by record type, action, person and dates, cursor-paged                        | —                                                    |

The portal help-center page that reads published articles is Phase 5.

## Rules as built

- **Admin API (E20):** bearer-token auth like the rest of the API (no cookies, so CSRF does not apply). Sign-in,
  admin access, the section check and the per-user write limit (120 writes a minute) run before the body is read.
  Team Leads get 403 (not a validation error) for anything outside their scope.
- **Every write** goes through the admin writer: the change and its audit row commit together (a failed change
  leaves no audit row), then `config:updated {scope, version}` goes to every socket. Secrets are never stored in
  the audit log (a webhook URL becomes its host) and phone numbers are masked. Reorders are audited with a label
  (for example "Categories", "<team> macros").
- **Lost updates (E19):** every edit sends the `updatedAt` it started from; a stale one gets 409 "Someone else
  changed this — reload". The web keeps the version the edit started from (it does not silently move to a newer
  one while the form is dirty). Linking a field to a category from either side moves both rows' `updatedAt`. A
  team role change needs the team's `expectedUpdatedAt`. A user's own sign-in and locale change do not count as
  edits (they are written without moving `User.updatedAt`), so an admin editing that account isn't refused.
  Other 409s: `duplicate` (unique value taken, the field says which), `in_use`, `guard` (below).
- **Guards (E5):** `team_has_active_categories`, `team_has_open_tickets`, `team_in_escalation`, `security_category`,
  `security_category_last_subtype`, `category_team_archived`, `escalation_team_archived`, `field_type_in_use`,
  `option_in_use`, `team_archived`, `member_is_on_call`, `self_role`, `self_disable`, `last_super_admin`,
  `signup_not_pending`. Rows are locked `FOR NO KEY UPDATE`; guards that depend on another row read it `FOR SHARE`,
  so an archive and a create that references the archived row can't both succeed. A category holds at most 30
  fields, enforced from both sides.
- **Keys (E4):** generated from the English label (`-2` suffix on a collision, `_2` for custom fields, archived rows
  included) and immutable. When the viewer may not see every row (macros, organisations), the web leaves the key
  out while it still follows the label and the API picks a free one; the toast names the key actually created.
- **Labels:** invisible format characters and bidi controls are removed; a label with nothing visible left counts
  as empty.
- **Form config (E18):** the ticket-form cache is guarded by a Redis generation, so a slow reader can't refill it
  with an old config after an admin change. The web refetches until it sees the announced version; after a Redis
  reset (a lower version) it accepts the answer after one confirming refetch. Categories whose team is archived are
  left off the form. An open New Ticket form keeps its input; a category, sub-type or option archived meanwhile is
  cleared with a polite notice, and a Security Incident follows a changed security category.
- **Escalation (E13):** a chain's delays never go down from one step to the next (400 `chain_order`). A reorder
  keeps the time slots and moves the rules into them. The worker fires the first rule in the current chain that
  has not fired in this P1 period (fired rules come from the `ESCALATED` events), so a reorder mid-chain never pages
  a rule twice or skips one. A step that fires early waits again; a shortened delay is picked up by the SLA scan
  within a minute. Every escalation writer takes the chain's lock before the rule row.
- **SLA and calendar (E12):** changes apply to new tickets and later priority changes; open tickets keep their
  stored due dates (the UI says so). "N business days" uses the configured business-day length.
- **Settings (E11):** a time-zone or digest-time change reschedules the worker's jobs within a minute. The audit log
  shows times in `business.timezone`; the rest of the app still uses Asia/Qatar.
- **Staff (E9):** staff are created on `STAFF_EMAIL_DOMAIN` with no password; the first Microsoft sign-in links the
  account. A role or status change bumps `sessionVersion`, which cuts API tokens and sockets at once. Nobody can
  demote or disable themselves or the last active Super Admin.
- **Clients (E10):** email domains are lower-case hostnames, unique across organisations (archived included), never
  the staff domain or a public mail domain (a static list plus provider-name rules such as `hotmail.<country>`).
  Pending sign-ups are approved into an organisation or rejected; a rejected sign-up stays listed under
  "Show rejected sign-ups" and can still be approved (self-service stays closed after a reject).
- **Email templates (E14):** unknown placeholders, malformed brace text (`{{ticket-number}}`, `{{name}`) and block
  variables outside the body are refused. The old P1 placeholder names from Phase 3 rows are still accepted.
- **Accessibility and RTL:** sheets trap and return focus (to the row, or the row now in its place), guard unsaved
  changes on close, Escape and browser Back; reorder works with Move up / Move down and announces the new position;
  Arabic strings isolate phone numbers, URLs, domains and ids (LRI…PDI), checked by a test.

## How to see it locally

- `pnpm dev`, sign in at http://localhost:3000/staff/login as `noor.alkaabi@loonsgroup.com` (Super Admin, password
  `LoonsDemo2026`) and open **Admin**. `hana.yousef@loonsgroup.com` shows the Team Lead view (Teams & members and
  Macros for the seven teams that account leads).
- **Live refresh:** open New ticket as `aisha.alkuwari@hamad.qa` in another browser (or a private window), then
  create a category with its first sub-type and a custom field linked to it; the open form shows them without a
  reload.
- **Audit log:** every change above appears in Admin → Audit log; open an entry for the before/after of the changed
  fields.

## Testing notes

- New API suites `admin-*` (one or more per section, plus `admin-write`, `admin-routes`, `admin-concurrency`,
  `admin-escalation-retiming`, `admin-categories-archived-refs`, `admin-categories-e2e-cleanup`) and
  `ticket-archived-refs`; unit tests next to `services/admin/*`. Web: kit and section tests next to the components,
  `admin-messages.test.ts` (EN/AR parity and RTL-1).
- E2E: `admin.spec.ts` creates config rows with the exact keys `e2e-<13 digits>` and `e2e-<13 digits>-panel`; the
  teardown (`db:cleanup-e2e`) removes only that shape (never macros, never a row a remaining ticket uses) and bumps
  the config version. The spec also checks the sheet's Back guard in a real browser.
- API admin tests create `test-…` config rows and `t-<hex>@` users in the dev database and remove them afterwards;
  a crashed run can leave some behind (see `PHASE2_HANDOFF.md` → Testing notes for the cleanup).

## Known limitations

- Email-template preview requests count toward the 120-a-minute admin write limit (the editor debounces them).
- After a reorder while a P1 is mid-chain, the P1 banner can show a different next step than the one the worker
  fires (the banner counts step numbers; the worker follows rules). Fixing it needs "fired" data in the ticket
  detail.
- API placeholder errors don't name the refused placeholder (the web editor does).
- Databases seeded before Phase 4 show six email templates as "Customized" (P1_ALERT, P1_ESCALATION,
  P4_DAILY_DIGEST, PASSWORD_RESET, EMAIL_VERIFICATION, GOOGLE_LINKED) with the older seed wording; press **Reset to
  default** on each to get the current wording. Fresh installs match the defaults.
- A category that already had more than 30 linked fields before the cap existed can't be saved from its sheet until
  links are removed from the custom-field side (development data only).
- The sheet's Back guard can leave one extra history entry after a Next refresh or a dev hot reload.
- The category preview's default asset hint follows the UI language, not the preview's EN/AR switch.
- The public-domain rule is a list plus heuristics; an unusual consumer provider can still be claimed.
- Disabling an on-call staff member is allowed and only warns; Team Leads can read staff emails in pickers; the
  pending sign-ups count covers loaded pages; the audit log is append-only by API design (no database trigger);
  only P1 escalation chains are editable.

## Carry-overs for Phase 5 and later

- Phase 5: the portal help-center page (published articles), reports, the staff activity timeline over
  `TicketEvent`.
- Server-computed next escalation step in the ticket detail (fixes the banner limitation above).
- A `params` field on validation issues so the API can name a refused placeholder.
- One app-wide display time zone from `business.timezone` (only the audit log follows it today).
- From Phase 3: an organisation-level P1 create limit, a sweeper for deliveries stuck in `QUEUED`, a digest window
  based on the last digest sent. Possibly a separate limit for admin previews.
