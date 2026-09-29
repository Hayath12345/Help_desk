# Phase 2 — handoff notes (Tickets & chat)

Read [`PHASE1_HANDOFF.md`](PHASE1_HANDOFF.md) first (architecture, conventions, setup). The Phase 2 build contract is
[`PHASE2_CONTRACT.md`](PHASE2_CONTRACT.md); the rules that changed after the reviews are listed below and are marked
★ in the contract.

## Where things stand (branch `phase-2-tickets-chat`)

Phase 2 is built and went through four review rounds, each fixed and re-verified:

1. Independent review of the build: 34 verified findings (security, SLA, realtime, cache races, Arabic/a11y).
2. Security + UI re-review of those fixes: 8 findings.
3. Adversarial "try to refute" pass over the re-review fixes: 26 follow-up gaps (plus one owner decision, below).
4. Adversarial verification of the round-3 fixes: 9 gaps.

Every finding has a regression test that fails when the fix is reverted (checked by mutation runs).

**Done-when criteria (contract):** the E2E realtime flow (client creates a ticket → agent replies in realtime → client
sees it without reloading) and the internal-note leak test both pass (`apps/web/e2e/tickets.spec.ts`,
`apps/api/test/realtime-tickets.test.ts`, `apps/api/test/tickets-messages.test.ts`).

### What was built

- **API** (`apps/api/src/routes/{tickets,attachments,staff,config}.ts`, `services/*`): every endpoint in the contract
  table — ticket form config, form context, requester search, create/list/counts/get/update tickets, messages
  (idempotent on `clientTempId`), attachments (presign → direct upload → complete → download), macros, teams. Rules
  live in `services/ticket-state.ts` (status machine + events), `ticket-query.ts` (visibility in SQL, search, sorts,
  cursor pagination, counts), `ticket-access.ts`, `custom-fields.ts`, `sla.ts` (business calendar from
  BusinessHours + Holidays + `business.timezone`), `attachments.service.ts`.
- **Realtime** (`apps/api/src/realtime/`): rooms `ticket:{id}`, `ticket:{id}:staff`, `team:{id}`, `user:{id}`;
  `ticket:join/leave`, `message:typing`; emits after commit; eviction on permission changes across instances;
  connection, packet, event and room limits (`limits.ts`, `socket.ts`).
- **Web** — shared ticket UI (`components/tickets/**`: New ticket modal, thread, composer, dropzone, shared
  `UploadChip`, SLA text), the client portal (`app/(portal)/tickets`, `tickets/[ref]`), the agent console
  (`app/(console)/console/inbox`, `components/console/**`: views/teams, list, conversation, composer with Public reply
  / Internal note, right panel with SLA card, status control, property editors, requester card). Data layer in
  `lib/tickets/**` (TanStack Query, optimistic updates), `lib/realtime/**` (one socket per tab, room join catch-up,
  ordered and batched join/leave with retries), `lib/uploads/**`.
- **Database**: migration `20260926062313_ticket_sla_pauses` adds `Ticket.slaPauses` (jsonb, finished PENDING
  pauses). The seed is unchanged and idempotent.

## Rules that changed after the reviews (binding; marked ★ in the contract)

### Tickets and SLA

- **PATCH priority:** recompute both due dates from `createdAt` with the new policy, **replaying the ticket's finished
  PENDING pauses (`Ticket.slaPauses`) on the resolution clock**; keep `firstReplyDueAt` if the first reply already
  happened. The first-reply clock never pauses.
- **PENDING:** entering PENDING sets `slaPausedAt`; leaving it appends `{from, to}` to `slaPauses` and resumes the
  resolution clock carrying the remaining time **to the millisecond** (no minute rounding). An already-overdue
  ticket stays overdue.
- **Sort `sla` and view `risk`:** PENDING counts as paused only once the first reply was sent (or the ticket has no
  first-reply target). A PENDING ticket that was never answered keeps its first-reply countdown, sorts with the
  unanswered tickets and can be in `risk`. `slaState()` in `@loons/shared` and the SQL twins agree.
- **Inactive organisation:** clients of an organisation with `isActive = false` can read but get `403 FORBIDDEN` on
  create, message post, presign and PATCH (`assertClientCanWrite`).
- **Input hygiene:** the shared zod schemas (`cleanText`) strip C0 control characters (except tab/LF/CR) and replace
  unpaired UTF-16 surrogates with U+FFFD (`toWellFormed`), and so do custom-field strings, so jsonb writes never fail
  with a 500. Cursors outside years 0001–9999 are `400`.

### Attachments

- **presign** keeps the file-name extension only if it belongs to the declared MIME type (otherwise the canonical
  extension from `UPLOAD_MIME_EXTENSIONS` is appended: `Invoice.pdf.exe` → `Invoice.pdf.exe.pdf`), generates the
  attachment id up front and signs the upload key `attachments/<attachmentId>/<name>`.
- **File names** (`sanitizeFileName`, idempotent): well-formed first, last path segment only, control / bidi /
  invisible format characters stripped (including U+061C, U+180E, U+200B–U+200F, U+202A–U+202E, U+2060–U+2069, BOM),
  NFC, reserved characters replaced, capped at **200 UTF-8 bytes** keeping the extension (MinIO refuses key segments
  over 255 bytes). The stored name, the object key and the download name always agree.
- **complete** HEADs the upload, **copies it (pinned by ETag) to `files/<attachmentId>/<uuid>/<name>`**, deletes the
  upload key, checks the magic bytes against the declared type (mismatch ⇒ REJECTED), runs the scan hook and serves
  **only the copy**. Refusals are `400 BAD_REQUEST` with `error.details.reason` ∈ `mismatch | content | infected`
  (`UPLOAD_REJECTION_REASONS`). A swap of the upload between check and copy returns 409 and the row stays PENDING.
- **One confirmation at a time:** `complete` takes a Redis lock per attachment (`SET … NX PX 120000`, released by
  compare-and-delete); a concurrent caller gets **409 "This upload is already being checked; try again shortly"**.
  If Redis doesn't grant the lock within 2 s the confirmation runs unlocked (the DB claim still keeps exactly one
  stored copy) and a late lock is released afterwards.
- **Storage errors on HEAD:** a 400 (MinIO refusing the key) ⇒ 409 "The file has not been uploaded yet"; 401/403 and
  anything else stay a 500 — they are a credential or permission fault of the API, not the client's.
- **Visibility (SEC-WEB-1, server side):** presign takes `visibility: 'public' | 'internal'` (default `public`) and
  stores it (`Attachment.visibility`, enum `AttachmentVisibility`). Only staff may presign `internal` (a client gets
  403, checked before the budget, so no row and no bytes). `attachmentLinkIssues(db, actor, ids, ticketId, target)`
  refuses a file of the other kind with a 400 issue `{path: ['attachmentIds', i], code: 'attachment_visibility'}`,
  and `linkAttachments(…, target)` filters on visibility in its `updateMany`, so a race past the check fails the
  count guard and rolls the whole transaction back. Ticket create links as `PUBLIC` (the description is public); a
  message links as its own type. A `clientTempId` replay is answered before the check.
- **Daily upload budget** (`apps/api/src/lib/upload-quota.ts`): per user over a rolling 24 h, in declared bytes at
  presign, `UPLOAD_DAILY_BYTES_PER_USER` (default 2 GiB). One sorted set per user at
  `<redisPrefix>upload-quota:<userId>` (member `<attachmentId>|<bytes>`, score = reservation time in ms from Redis
  `TIME`), updated by one Lua script that trims, sums and adds only when the file fits, so concurrent presigns can't
  overshoot; the key expires one window after its newest entry. Over budget ⇒ 429 RATE_LIMITED with
  `details = {reason: 'daily-quota', limitBytes, retryAfterSeconds}` and `Retry-After`; `retryAfterSeconds` is when
  the oldest reservations whose bytes cover the excess age out. A reservation stays counted when the upload is
  rejected or never sent (the POST lets the caller write those bytes for 15 min); only a presign that fails on the
  server (`createUploadPost` or the insert throws) gives its bytes back. A file larger than the whole budget is 400
  `file_too_large`. Redis errors or > 2 s ⇒ fail open with a warning, like the presign limit. `reserve` / `release`
  throw a TypeError for a size that is not a whole number from 1 to `MAX_SAFE_INTEGER`, and the script counts a
  member it cannot read as 0 (one odd member must not turn every later check into "fail open").
- **Mismatched images:** at `complete`, an allowed image declared as another allowed image type (a JPEG named .png) is
  accepted as its detected type (`detectAllowedImageType`): the row's `mimeType` and `fileName`
  (`fileNameForDetectedType`: image extension replaced, else the canonical one appended; 200-byte cap kept) are
  updated with the CLEAN status, the scan hook sees the detected type, and `download` signs the row's `mimeType` as
  the response Content-Type. The object key keeps the original name and the stored object keeps the declared
  Content-Type. heic/heif are one family; a declared heic/heif needs a HEIF image brand in `ftyp` (major brand, or a
  HEVC image brand among the compatible ones), so MP4 / QuickTime / AVIF are refused. Everything else stays strict.

### Realtime

- **Limits** (`apps/api/src/realtime/limits.ts`, `DEFAULT_REALTIME_LIMITS`; per API instance). Tunable through the
  environment (positive integers; anything else stops startup):

  | Variable                                | Default | What it limits                                                      |
  | --------------------------------------- | ------- | ------------------------------------------------------------------- |
  | `REALTIME_SOCKETS_PER_USER`             | 20      | sockets one user may hold                                           |
  | `REALTIME_SOCKETS_PER_IP`               | 500     | sockets one client address may hold (`TOO_MANY_CONNECTIONS`)        |
  | `REALTIME_HANDSHAKES_PER_IP_BURST`      | 200     | new connections per address at once (then 403 at the upgrade)       |
  | `REALTIME_HANDSHAKES_PER_IP_PER_SECOND` | 20      | refill of the above                                                 |
  | `REALTIME_PENDING_CONNECTIONS_PER_IP`   | 50      | connections per address still waiting for their Socket.IO handshake |

  Fixed in code: a connection without a successful handshake is closed after **10 s** (websocket and polling); at
  most 3 packets and one CONNECT in flight before the handshake; **any refused handshake closes the connection**
  right after its `connect_error` (a polling client gets 2 s to fetch it); **any CONNECT after the handshake closes
  the connection**; every engine.io packet of any type (messages, acks, pings/pongs, upgrade probes) spends one token
  of a per-connection bucket (2000 burst, 200/s) and the connection is closed when it runs dry; at most 3 upgrade
  requests per session and one probe per upgrade; payloads are capped at **16 KB** (`maxHttpBufferSize`, advertised
  to clients as `maxPayload`; a bigger polling POST gets 413 before it is decoded); POSTs to a session that is
  already closing get 400 unread. Every Socket.IO event, whatever its name, spends one token of a per-socket budget
  (500 burst, 80/s ⇒ ack `RATE_LIMITED`); `ticket:join` 150 burst / 15 per s per socket and 300 / 30 per user;
  `ticket:leave` 300 / 60. Refusals decided in memory count against a token bucket (500 at once, refilled at 50/s);
  when it runs dry the socket is disconnected.

- **Addresses:** per-address limits key on the client address as `TRUST_PROXY` resolves it, with IPv6 grouped by its
  /64 and IPv4-mapped IPv6 treated as IPv4 (`apps/api/src/lib/client-address.ts`) — the same keying as the HTTP rate
  limits. An office behind one NAT shares the per-address limits; raise them for large offices.
- **Ticket rooms:** at most `MAX_TICKET_ROOMS_PER_SOCKET` = 50 (`@loons/shared`). A join takes its slot when it
  arrives (joins in flight count) and a leave frees it when it arrives; a join over the cap is acked
  **`TOO_MANY_ROOMS`** (retryable after leaving a room). Join and leave for the same ticket are applied in the order a
  socket sent them.
- **Web client rooms** (`apps/web/lib/realtime/client.ts`): rooms released and acquired in the same tick are sent as
  one batch, **leaves before joins**; `TOO_MANY_ROOMS` is retried after a leave completes (or after a backoff),
  `RATE_LIMITED` with backoff 1 s → 30 s; `NOT_FOUND`, `FORBIDDEN`, `VALIDATION_FAILED` and `INTERNAL` are final for
  that holder. The portal list keeps `MAX_TICKET_ROOMS_PER_SOCKET − 10` = 40 live rows.
- **Eviction** (`ticketUpdated` in `apps/api/src/realtime/tickets.ts`), on every ticket update:
  1. local sockets are judged with the permissions they carry;
  2. with the Redis adapter, when the team or assignee changed, the users who lost access (old-team members not on
     the new team, the old assignee; super admins and the new team/assignee keep access) are read from the DB and
     removed from the ticket and staff rooms **on every instance** by their `user:{id}` room, without waiting, and are
     excluded from this emit. If that DB read fails, the old team's room (minus the new team and assignee) and the
     old assignee are excluded instead — fail closed;
  3. the cross-instance member check is bounded to **1 s** (the adapter's own timeout is 5 s); if another instance
     doesn't answer, local members are still judged with fresh permissions;
  4. the emit goes out with the evicted sockets and user rooms excluded, and the request waits (≤ 1 s) for a PING on
     the adapter's publishing connection so the leaves are delivered before the request is answered.

  Ordering: leaves, the emit and later emits of an instance share one Redis publishing connection, so every instance
  receives them in order, and anything published after the PATCH was answered (e.g. a note posted next on any
  instance) arrives after the leaves. `principals.invalidate(userId)` triggers `realtime.refreshUser(userId)` on all
  instances (disconnects inactive users, re-syncs team rooms, leaves rooms the user may no longer see).

### Web UI

- **Portal header:** EN `Handled by {assignee} ({team})` / unassigned `Handled by {team}` (design); AR
  `يتولاها {assignee} · {team}` / `يتولاها {team}` (Arabic team names already contain the parenthesised short name).
- **Status control (console):** a radiogroup with manual activation — arrow keys move focus only; Space/Enter saves.
- **Composer (console):** Public reply and Internal note keep separate attachment lists and macro-armed statuses.
- **Uploads:** `useAttachmentUploads({ visibility, ticketId? })` and `uploadAttachment(file, { visibility, … })`
  require `visibility` (no default, so a new call site fails `tsc` until it says who the file is for). The console
  Internal note uses `internal`; Public reply, the portal reply and New ticket use `public`. Upload failure reasons
  from presign: a 429 with `details.reason: 'daily-quota'` ⇒ `quota` ("This file doesn't fit in what's left of your
  upload allowance for the last 24 hours. Try again in N hours/minutes.", ICU plurals EN one/other, AR
  one/two/few/other; rounded up to minutes under an hour, else hours; computed once, no countdown); any other 429 ⇒
  `busy` ("Too many uploads in a short time…"); a 400 `file_too_large` ⇒ `allowance` ("larger than your daily upload
  allowance"). Retry stays for every failure. A finished chip takes the stored `fileName` / `mimeType`, so a
  corrected image shows its real name and icon.
- **Upload chips:** one shared `UploadChip` / `UploadChipList` (`components/tickets/upload-chip.tsx`) in the dropzone
  and the console composer. The failure reason sits under the chip (never inside it) and is linked to Retry/Remove
  with `aria-describedby`; the `role="status"` region announces only the **newest** failure (per tab in the console,
  so a failure that happened on the other tab is announced when you switch back). E2E covers 390 px in EN and AR, in
  the New ticket modal and the portal reply box.
- **Console thread:** the scroller is the single named, keyboard-focusable region "Conversation" / "المحادثة"
  (`TicketThread labelled={false}` inside it); its focus ring is drawn on an overlay above the messages.
- **Focus in forced-colors mode:** pair a focus ring with `outline-none focus-visible:outline-hidden` (or
  `has-[…:focus-visible]:outline-hidden`); rows inside a clipping container add
  `forced-colors:focus-visible:-outline-offset-2`. `components/tickets/forced-colors-focus.test.ts` guards
  `components/console`, `components/tickets` and `app/**`.
- **Bidi** (`lib/format.ts`): `isolate()` (first strong) and `isolateDirection(text, 'ltr' | 'rtl')`. The Arabic asset
  placeholder keeps the example ID LTR-isolated inside the translated words (so `2026-018` keeps its order), and the
  whole placeholder is RTL-isolated when it contains Arabic, LTR-isolated otherwise; English is unchanged.

## Testing notes

- **Use Node ≥ 24.16.0 on Windows** (24.21.0 is the current 24 LTS). Node 24.15.0 and older vendor libuv 1.51.0,
  whose `uv__is_fast_loopback_fail_supported()` (`src/win/tcp.c`) passes an uninitialised `OSVERSIONINFOW` to
  `RtlGetVersion` on every loopback TCP connect. That can overwrite the stack cookie and kill the process with
  `0xC0000409` (fast-fail 2) inside `uv__tcp_connect`. Fixed by libuv PR
  [#5107](https://github.com/libuv/libuv/pull/5107) (libuv 1.53.0), cherry-picked into Node 24.16.0 (2026-05-21,
  nodejs/node#62561); libuv issue [#5274](https://github.com/libuv/libuv/issues/5274) was closed on 2026-09-23 as a
  duplicate. The test suites make thousands of loopback connections (Postgres, Redis, MinIO, Socket.IO), so on
  24.15 a full API run loses a worker every few runs; the dev API, worker and Next.js server can crash the same way.
  Linux and macOS are not affected.
- `pnpm test` in `apps/api` runs `test/run-vitest.ts`. The root `engines.node` is now `>=24.16.0`; the wrapper runs
  `vitest run` and re-runs files whose worker died with `0xC0000409` only on a Node release known to have the bug
  (with the upgrade hint); on a fixed Node such a crash fails the run. The API suite also uses `pool: 'forks'`,
  `MSGPACKR_NATIVE_ACCELERATION_DISABLED=true` and a per-run Redis prefix `loons-test:<run>:` that
  `test/global-setup.ts` removes even after a crash.
- A crashed worker's DB fixtures are **not** removed automatically. They use unique keys (`Organization`/`Team`/
  `Category` keys `test-…`, users `t-<10 hex>@…`); delete them in one transaction in psql: tickets first, then
  `Attachment`, `CategoryField`, `Subtype`, `Category`, `Site`, `User`, `Team`, `Organization`.
- Don't run the full suites while other heavy work runs: under heavy CPU load a few web component tests can exceed
  vitest's 5 s timeout (they take about 1 s normally).
- `randomIp()` in `apps/api/test/helpers.ts` hands out each address once per process (198.18.0.0/15).
- `apps/api/test/attachments.test.ts` asserts the bucket's lifecycle rule (see Deployment notes) and waits for the
  real 2 s confirmation-lock timeout once (about 2.3 s).
- `pnpm test:e2e` (26 tests) needs Postgres, Redis, **MinIO** and Mailpit plus the API worker. The ticket spec raises
  tickets with a `[e2e:<timestamp>]` subject prefix as a seeded client; the global teardown (`db:cleanup-e2e`) deletes
  those tickets, the `e2e-…@hamad.qa` accounts and their stored MinIO objects (`files/<id>/` and
  `attachments/<id>/`). Clear the auth rate limits between runs (README → Troubleshooting).
- Upload follow-ups: `apps/api/test/upload-quota.test.ts` (the Redis script with a fake clock, and the HTTP presign
  budget with an injected clock and a 1000-byte limit; `createTestContext` accepts
  `deps.uploadQuota {now, windowMs}`); `attachments.test.ts` has the visibility, backfill-migration and mismatched-image tests;
  `src/lib/storage.test.ts` the detection and HEIF-brand rules. The e2e ticket flow attaches a JPEG named .png (stored
  and downloaded as .jpg) and a file on the Internal note (presigned `internal`, never on the Public reply tab, never
  received by the client).
- Reviewer probe scripts (attack scripts for the security findings) live outside the repo; each finding has a
  regression test instead (`apps/api/test/realtime-limits.test.ts`, `realtime-cluster.test.ts`, `attachments.test.ts`,
  `tickets-*.test.ts`, `src/lib/storage.test.ts`, `src/lib/client-address.test.ts`, web component tests next to the
  components).

## Deployment notes for Phase 6

- **Bucket lifecycle:** the `attachments/` prefix holds transient uploads (the pre-signed POST policy stays valid 15
  minutes after `complete` deleted the object, so a re-POST can leave an unreferenced object under
  `attachments/<attachmentId>/`). Confirmed files live under `files/` and must **not** expire. Locally,
  `docker-compose.yml`'s `minio-init` imports the rule (re-runnable; it replaces any other lifecycle rules on the dev
  bucket; an existing local setup needs `docker compose up minio-init` once after pulling, and
  `apps/api/test/attachments.test.ts` fails with that instruction while the rule is missing). Production (S3), save as
  `lifecycle.json`:
  ```json
  {
    "Rules": [
      {
        "ID": "expire-browser-uploads",
        "Status": "Enabled",
        "Filter": { "Prefix": "attachments/" },
        "Expiration": { "Days": 1 },
        "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
      },
      {
        "ID": "remove-upload-delete-markers",
        "Status": "Enabled",
        "Filter": { "Prefix": "attachments/" },
        "Expiration": { "ExpiredObjectDeleteMarker": true }
      }
    ]
  }
  ```
  ```bash
  aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json
  ```
  The second rule only matters on a versioned bucket (`ExpiredObjectDeleteMarker` can't share a rule with `Days`).
  Keep the bucket **unversioned**: on a versioned bucket the API's deletes under `files/` (rejected uploads, e2e
  cleanup) would also leave noncurrent versions, which this lifecycle does not cover. Expiry runs on the store's own
  schedule (S3 rounds to the next midnight UTC), so orphans live 24–48 h.
- **IAM for the API role:** `s3:GetObject` (HEAD and signed downloads), `s3:PutObject` (the server-side copy),
  `s3:DeleteObject`; the browser's pre-signed POST needs `s3:PutObject` on `attachments/*`.
- **Bucket CORS:** browsers upload straight to storage, so the bucket must allow `POST` from `APP_URL`; the web CSP
  `connect-src` must include `NEXT_PUBLIC_UPLOAD_ORIGIN`.
- **Migrations `20260929063553_attachment_visibility` + `20260929071227_attachment_visibility_backfill`:** the first
  adds enum `AttachmentVisibility {PUBLIC, INTERNAL}` and `Attachment.visibility NOT NULL DEFAULT 'PUBLIC'`; the
  second marks files already linked to INTERNAL messages `INTERNAL` (re-runnable). Unlinked uploads presigned before
  the deploy are PUBLIC: a note upload in flight during the deploy has to be uploaded again (400
  `attachment_visibility`). The seed is unchanged.
- **Upload budget env:** `UPLOAD_DAILY_BYTES_PER_USER` (positive integer, blank ⇒ 2147483648; an invalid value stops
  the API with a ConfigError). With several API instances the budget is shared (Redis `TIME`). It fails open while
  Redis is down, as does the presign limit, so nothing bounds uploads during a Redis outage.
- **Multiple API instances:** `SOCKET_REDIS_ADAPTER=true` is required. Socket limits are per instance (N instances ⇒ N
  × the budget). With an unresponsive instance still subscribed to Redis (e.g. a host that died without closing its
  connection, until Redis notices after `tcp-keepalive`), every PATCH and PUBLIC message waits up to about 1 s for the
  cross-instance check; eviction stays fail-closed.
- **Virus scanning:** `storage.scanHook` is still the no-op hook (`NOT_SCANNED` is treated as CLEAN after the
  magic-byte check). Plug in ClamAV or GuardDuty Malware Protection for S3 before go-live.
- **Node:** production images run Linux, which the libuv loopback crash does not affect; still build on Node ≥ 24.16.0
  (see Testing notes) and pin the exact version in the Phase 6 Dockerfiles.

## Decisions for the owner / known limitations

- **Per-user upload volume** (review round 3): resolved — a rolling 24 h budget per user in declared bytes
  (`UPLOAD_DAILY_BYTES_PER_USER`, default 2 GiB; see Attachments). Rejected or never-sent uploads use budget until
  they age out (by design).
- **Staff creating a ticket for another team** (review P2-CC-4): the API keeps team-scoped visibility, so the creator
  cannot open the ticket unless they are on that team or assigned. The web shows "Ticket LG-n created and routed to
  <team>" and stays on the page. Alternative: give creators read access to tickets they raised (contract change).
- **Attachment visibility** (SEC-WEB-1 server side): resolved — fixed at presign and enforced when linking (see
  Attachments). Downloads and the ticket detail still gate on the message type as before.
- **Mismatched images:** resolved — a JPEG named `.png` is stored as `image/jpeg` with a `.jpg` name. The object in
  the bucket keeps the declared Content-Type; only signed downloads correct it (response-content-type override).
- **Pause credit before the migration:** tickets paused before `Ticket.slaPauses` existed have an empty history, so a
  priority change on them drops pause credit earned earlier. Seeded tickets never had pause credit.
- **Other upload errors** (403 inactive organisation or a client presigning `internal`, 409 changed during check or
  already being checked) are shown by the web as a generic upload failure with Retry; the three `complete` refusals,
  the daily-quota 429, other 429s (`busy`) and `file_too_large` (`allowance`) carry their own text.
- **Realtime residuals:** a `ticket:leave` refused as `RATE_LIMITED` is treated as left by the web client (the server
  may keep that room until reconnect; a later join then gets `TOO_MANY_ROOMS` and is retried). In the DB-failure
  fallback of eviction, everyone in the old team's room misses that one `ticket:updated` (over-inclusive, never open).
  A polling session closed by Socket.IO itself (token expiry, flood disconnect) can stay "closing" up to engine.io's
  30 s; its POSTs are refused unread.
- **Forced-colors focus** is fixed in the console, ticket components and portal pages; `components/ui/**` and
  `components/shell/**` (Phase 1 shell) still use `outline-none` + ring, and the combobox popover keeps shadcn's
  unconditional `outline-hidden`.

## Carry-overs for Phase 3

- SLA worker: at-risk / breach flags and notifications, auto-close of solved tickets, P1 acknowledge + escalation
  (`TicketEvent` types and `slaState` already exist; the `risk` view is computed live today).
- Orphan sweep: a periodic job that deletes `Attachment` rows in PENDING/REJECTED older than the POST policy and any
  `attachments/` objects a lifecycle rule did not catch.
- Notifications: `notification:new` on `user:{id}` is wired on the server side but unused; the client socket ignores it.
- Email templates for ticket events still need the "block variable" rule from the Phase 1 carry-overs (multi-line
  `messageBody` / `description` that keeps paragraphs and is never linkified).
- Admin (Phase 4): any change to a user's teams, role or status must call `principals.invalidate(userId)`; the API
  wrapper then refreshes that user's sockets everywhere. Config edits must bust the ticket-form config cache
  (`config:updated`). Category placeholders become editable then — the Arabic placeholder rules above already cover
  Latin fallbacks and digit-first examples.
- Forced-colors focus for `components/ui/**` and `components/shell/**`.
