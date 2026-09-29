# Phase 2 — Tickets & chat: build contract (binding)

Scope (spec `docs/BUILD_SPEC.md` §14.2, with §1, §5, §7, §8, §12): New Ticket modal driven by DB config (dependent
sub-type, auto-priority, P1 banner, Security Incident behaviour, custom fields, attachments), My tickets, ticket thread,
agent Inbox/queue/thread/right panel, Socket.IO realtime chat, internal notes, status/priority/assignee changes with
optimistic UI and animations. **Done when:** the E2E realtime flow passes (client creates a ticket → agent replies in
realtime → client sees it without reloading) and the internal-note leak test passes.

Out of scope (later phases): SLA worker (at-risk/breach flags, notifications, auto-close — Phase 3), P1 acknowledge +
escalation (Phase 3), admin editing of config (Phase 4), Team queue / Customers / Reports / Help center data (Phase 5).

Read first: `docs/PHASE1_HANDOFF.md` (architecture, conventions, setup) and README.md.

> **Amended after the Phase 2 review (2026-09-26).** Rules marked **★** below were changed or added after the build;
> `docs/PHASE2_HANDOFF.md` explains each change. The rest of this contract is unchanged and was built as written.

## Binding shared code (already written — build on it, don't fork it)

- `packages/shared/src/schemas/tickets.ts` — every request/response schema of the ticket API (DTOs, limits).
- `packages/shared/src/tickets.ts` — status rules (`statusAfterMessage`, `clientCanSetStatus`, `staffCanSetStatus`,
  `ACTIVE_STATUSES`), console views (`STAFF_VIEWS`), client tabs, sorts, SLA display state (`slaState`,
  `isSlaAtRiskOrBreached`).
- `packages/shared/src/sla.ts` — SLA due-date arithmetic interface (`addSlaMinutes`, `slaMinutesBetween`,
  `computeDueDates`, `resumeDueDate`); the SLA builder implements the two stubbed functions.
- `packages/shared/src/realtime.ts` — Socket.IO event names, payloads, client events + ack shape, room semantics.
- `packages/shared/src/permissions.ts` — who can view/update/join what (unchanged; use it everywhere).
  If a builder needs a change to a shared contract file it does NOT edit it: it reports the exact change needed.

## API (apps/api) — endpoints (all Bearer-authenticated, `requireAuth()`; unverified/pending users get 403)

| Method & path                                                                                                       | Schemas                                                                              | Who                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| GET `/config/ticket-form`                                                                                           | → `ticketFormConfigSchema`                                                           | any active user                                            |
| GET `/tickets/form-context?requesterId=`                                                                            | `formContextQuerySchema` → `formContextSchema`                                       | client (self) / staff (requesterId required)               |
| GET `/requesters?search=&limit=`                                                                                    | `requesterSearchQuerySchema` → `requesterListSchema`                                 | staff                                                      |
| POST `/tickets`                                                                                                     | `createTicketSchema` → 201 `ticketResponseSchema`                                    | client / staff                                             |
| GET `/tickets`                                                                                                      | `listTicketsQuerySchema` → `ticketListSchema`                                        | client / staff                                             |
| GET `/tickets/counts`                                                                                               | → `ticketCountsSchema`                                                               | client / staff                                             |
| GET `/tickets/:ref`                                                                                                 | `ticketRefParamSchema` → `ticketResponseSchema`                                      | viewers of the ticket                                      |
| PATCH `/tickets/:id`                                                                                                | `updateTicketSchema` → `ticketResponseSchema`                                        | staff (all fields) / client (status SOLVED↔OPEN only)      |
| GET `/tickets/:id/messages?after=`                                                                                  | `listMessagesQuerySchema` → `messageListSchema`                                      | viewers (clients never get INTERNAL)                       |
| POST `/tickets/:id/messages`                                                                                        | `createMessageSchema` → 201 `createMessageResponseSchema` (200 on idempotent replay) | viewers; INTERNAL staff-only                               |
| POST `/attachments/presign`                                                                                         | `presignAttachmentSchema` → 201 `presignAttachmentResponseSchema`                    | any active user                                            |
| POST `/attachments/:id/complete`                                                                                    | → `completeAttachmentResponseSchema`                                                 | the uploader                                               |
| GET `/attachments/:id/download`                                                                                     | → `attachmentDownloadSchema`                                                         | viewers of the ticket (INTERNAL-message files: staff only) |
| GET `/macros`                                                                                                       | → `macroListSchema`                                                                  | staff                                                      |
| GET `/teams`                                                                                                        | → `teamListSchema`                                                                   | staff                                                      |
| Unknown / invisible tickets return **404** (never 403 — don't reveal existence). Errors use the Phase 1 error body. |

### Rules

- **Visibility:** `canViewTicket` (client: own org; agent/lead: own teams + assigned; super admin: all). Lists and counts
  are filtered in SQL with the same rule. Clients' list defaults to `scope=mine` (tickets they requested).
- **Create:** validate at request time against the live config (build a zod schema from the config, cached in Redis;
  bust on `config:updated` in Phase 4): category active; sub-type active and belongs to the category; `type =
SECURITY_INCIDENT` ⇒ category must be the `securityCategoryKey` ('cyber') (reject otherwise) and tag `security` is
  added; custom fields: only fields linked to the category, required ones present, values match type (TEXT/ASSET_ID ≤
  500 chars, NUMBER finite, DROPDOWN ∈ options, MULTI_SELECT ⊆ options, DATE ISO date, YES_NO boolean); site belongs
  to the requester's org and is active; attachments were uploaded by the caller, are UPLOADED/CLEAN and unlinked
  (code `attachment` otherwise) and **★** were presigned `public` (code `attachment_visibility` otherwise: the
  description is public).
  Priority = override ?? sub-type default. Team = category's team. Due dates = `computeDueDates(createdAt, policy,
calendar)` with the calendar from BusinessHours + active Holidays + AppSetting `business.timezone` (cache ≤ 60 s).
  Client-created: status NEW, channel PORTAL, requester = caller. Staff-created: `requesterId` required (active,
  verified CLIENT), status OPEN, channel PHONE, assignee = caller if they are on the team (else unassigned). The
  description becomes the first PUBLIC message (author = requester for clients, the staff creator otherwise) and the
  attachments link to that message. Writes TicketEvent CREATED (+ ASSIGNEE_CHANGED when assigned). One transaction.
- **Messages:** idempotent on `(ticketId, clientTempId)`. CLOSED ⇒ 409 CONFLICT. Clients: PUBLIC only (INTERNAL ⇒ 403).
  Status via `statusAfterMessage`; staff PUBLIC reply sets `firstRepliedAt` the first time (TicketEvent FIRST_REPLY with
  `meta.minutesToFirstReply`), assigns an unassigned ticket to the replying agent if they are on the team; entering /
  leaving PENDING pauses / resumes the resolution clock (`slaPausedAt`, `resumeDueDate`). **★** Leaving PENDING
  appends `{from, to}` to `Ticket.slaPauses`, and the resume carries the remaining time to the millisecond (an
  already-overdue ticket stays overdue). The first-reply clock never pauses. `lastMessageAt` updated.
  Every status/assignee change writes its TicketEvent. Attachments as in create (≤ 10 files, ≤ 25 MB total), except
  that **★** a PUBLIC message takes `public` uploads and an INTERNAL note `internal` ones: a file of the other kind is
  400 VALIDATION_FAILED with the issue code `attachment_visibility` at path `['attachmentIds', i]` (location
  `body`, message `validation.invalid`). The whole request is refused (nothing created or linked, so the same
  `clientTempId` can be retried); a replay of a stored `clientTempId` returns the stored message (200) unchecked.
  **★** Clients of an inactive organisation get 403 on create, message post, presign and PATCH (reads still work).
- **Update (PATCH):** apply each field, validate (`staffCanSetStatus` / `clientCanSetStatus`; assignee = active staff
  member of the ticket's team or a super admin; category change ⇒ team = category's team + `subtypeId` of that category
  required; priority change ⇒ recompute due dates from createdAt with the new policy, **★** replaying the ticket's
  finished PENDING pauses (`Ticket.slaPauses`) on the resolution clock and keeping `firstReplyDueAt` if the first
  reply already happened; tags: create missing Tag rows by key; customFields validated like create), one
  TicketEvent per changed field (STATUS_CHANGED, PRIORITY_CHANGED, ASSIGNEE_CHANGED, TEAM_CHANGED, CATEGORY_CHANGED,
  SUBTYPE_CHANGED, TAGS_CHANGED; from/to values as the seed does: enum values or ids; tags meta {added, removed}),
  SOLVED sets `solvedAt`, reopening clears it. No-op PATCH ⇒ 200 unchanged.
- **Preview:** latest PUBLIC message body, whitespace-collapsed, ≤ 140 chars. Never INTERNAL.
- **Attachments:** `presign` checks MIME against `ALLOWED_UPLOAD_MIME_TYPES`, size ≤ 25 MB, sanitises the file name
  (**★** keeping its extension only if it belongs to the declared type, else appending the canonical one from
  `UPLOAD_MIME_EXTENSIONS`), creates an Attachment (PENDING, uploader = caller, ticketId optional — must be visible
  if given; **★** the id is generated before signing and the upload key is `attachments/<attachmentId>/<name>`)
  and returns a pre-signed POST limited by content-length-range and content-type (expires in 15 min).
  **★** `visibility: 'public' | 'internal'` (default `public`, `ATTACHMENT_VISIBILITIES`) is stored on the row and
  fixes which messages the file can be linked to (see Create / Messages); a client asking for `internal` gets 403
  FORBIDDEN (no row, no budget used). **★** Daily budget: when the caller's reserved bytes over a rolling 24 h plus
  this file's `sizeBytes` would exceed `UPLOAD_DAILY_BYTES_PER_USER` (default `DEFAULT_UPLOAD_DAILY_BYTES_PER_USER`
  = 2 GiB), presign answers 429 RATE_LIMITED "Daily upload limit reached. Try again in N seconds." with
  `details = {reason: 'daily-quota', limitBytes, retryAfterSeconds}` (`uploadQuotaDetailsSchema`) and a `Retry-After`
  header; `retryAfterSeconds` (≥ 1) is when enough old reservations age out for THIS file. The per-request presign
  limit's 429 carries only `{retryAfterSeconds}` (no `reason`), which is how clients tell the two apart. A file larger
  than the whole budget is 400 VALIDATION_FAILED on `sizeBytes`, code `file_too_large`. Reservations are atomic (one
  Redis script), count declared bytes and stay counted when the upload is later rejected or never sent.
  `complete` HEADs the object, checks size/type match, **★** copies it (pinned by ETag) to
  `files/<attachmentId>/<uuid>/<name>`, deletes the upload key, rejects content whose magic bytes don't match the
  declared type, runs the scan hook on the copy, sets UPLOADED→CLEAN (or INFECTED/REJECTED + delete the copy) and
  only ever serves the copy; refusals are 400 BAD_REQUEST with `details.reason` ∈ `mismatch | content | infected`
  (`UPLOAD_REJECTION_REASONS`); a swap between check and copy is 409 and the row stays PENDING for a retry.
  **★** An allowed image declared as another allowed image type (a JPEG named .png, a PNG named .jpg, a HEIC declared
  as PNG) is accepted as what it really is: the row and the returned attachment get the detected `mimeType` and a
  `fileName` whose image extension is replaced (or the canonical one appended when the name has no image extension),
  sanitised as always. heic and heif are one family and stay as declared, but a declared heic / heif needs a HEIF
  image brand in its `ftyp` box (an MP4, QuickTime or AVIF file is refused). Anything that is no allowed image, and
  every non-image declared type, is still refused with reason `content`.
  **★** One confirmation per attachment at a time (Redis lock): a concurrent `complete` gets 409 "already being
  checked". A storage 400 on HEAD ⇒ 409 "not uploaded yet"; 401/403 stay 500. **★** File names are made well-formed,
  stripped of control / bidi / invisible characters, NFC-composed and capped at 200 UTF-8 bytes keeping the
  extension (`sanitizeFileName`, idempotent). `download` returns a 5-minute signed GET with `Content-Disposition: attachment; filename*=UTF-8''…`
  and **★** the row's `mimeType` as the response Content-Type (signed override). Browser uploads
  go straight to storage: MinIO must answer CORS for the web origin (verify; configure via docker-compose env if
  needed) and the web CSP `connect-src` must allow `NEXT_PUBLIC_UPLOAD_ORIGIN`. Per-user rate limit on presign.
  **★** The `attachments/` prefix is transient: a bucket lifecycle rule expires it after 1 day (`minio-init`
  adds it locally; the API test suite asserts it exists), and `db:cleanup-e2e` sweeps `attachments/<id>/` and
  `files/<id>/` for the rows it deletes.
- **★ Input hygiene:** shared schemas strip C0 control characters (except tab/LF/CR) and make strings well-formed
  (`cleanText`) on subject, description, asset id, message body, search and requester search; custom-field strings
  likewise. Cursors outside years 0001–9999 ⇒ 400.
- **Search:** subject ILIKE, `LG-n`/`n` exact number, requester name/email ILIKE.
- **Sort `sla`:** done statuses last; then tickets without a first reply first; then the next due date ascending
  (first reply due if not replied, else resolve due; PENDING = paused → after active ones); tie-break createdAt.
  **★** PENDING counts as paused only once the first reply was sent (or there is no first-reply target): an
  unanswered PENDING ticket keeps its first-reply clock, sorts with the unanswered tickets and can be in `risk`
  (`slaState()` and the SQL twins agree). `recent`: `updatedAt` desc. Cursor pagination must be stable.
- **Counts:** staff `views` use the same predicates as the list (`risk` uses `isSlaAtRiskOrBreached` semantics — compute
  in SQL or in memory over the visible active set), `teams` = active tickets per team the caller can see (super admin:
  all active teams; others: their teams). Client `tabs` over their `scope=mine` set.

### Realtime (apps/api/src/realtime)

- On connect: staff auto-join `team:{id}` for each team (super admin: every active team); everyone joins `user:{id}`.
- `ticket:join {ticketId}` → ack; joins `ticket:{id}` if `canJoinTicketRoom`, plus `ticket:{id}:staff` if
  `canJoinTicketStaffRoom`; unknown/invisible ⇒ ack `{ ok:false, error:'NOT_FOUND' }`. `ticket:leave` leaves both.
  Validate every payload with the shared zod schemas; never trust client data. **★** Join and leave for the same
  ticket are applied and acked in the order the socket sent them.
- **★ Limits** (`realtime/limits.ts` + `socket.ts`, per API instance; full table in `docs/PHASE2_HANDOFF.md` →
  Realtime): per-address limits (keyed by the `TRUST_PROXY`-resolved address, IPv6 by /64) on new connections (403 at
  the upgrade), pending handshakes and open sockets, tunable with `REALTIME_*` env variables; a connection is closed
  after 10 s without a handshake, after any refused handshake (right after its `connect_error`, so clients retry on a
  new connection), on any CONNECT after the handshake, and when its per-connection packet budget (every engine.io
  packet type) runs dry; payloads ≤ 16 KB; every event spends a per-socket token (over budget ⇒ ack `RATE_LIMITED`);
  `ticket:join` / `ticket:leave` have their own per-socket and per-user budgets; refusals decided in memory drain a
  bucket that disconnects the socket when empty. At most `MAX_TICKET_ROOMS_PER_SOCKET` (50, `@loons/shared`) ticket
  rooms per socket, joins in flight included; beyond it the join is acked `TOO_MANY_ROOMS` (retryable after a leave).
- **★ Eviction:** on every ticket update local sockets are judged at once; with the Redis adapter the users a
  re-route or re-assignment locked out are read from the DB and removed from the ticket rooms on every instance by
  their `user:{id}` room (fail closed if that read fails), the cross-instance member check is bounded to 1 s, the
  emit excludes every evicted socket and user, and the request waits (≤ 1 s) until Redis has delivered the leaves,
  so later messages from any instance arrive after them. `principals.invalidate(userId)` triggers
  `realtime.refreshUser(userId)` on all instances (disconnects inactive users, re-syncs team rooms, leaves rooms the
  user may no longer see).
- `message:typing {ticketId, isTyping, scope}` → client side: scope must be 'public', broadcast to `ticket:{id}`
  (excluding the sender); staff: broadcast to `ticket:{id}:staff` only (whatever the scope). Throttle per socket.
- After a DB commit (never before): PUBLIC/SYSTEM `message:new` → `ticket:{id}`; INTERNAL `message:new` →
  `ticket:{id}:staff` ONLY; `ticket:updated` (summary DTO) → `ticket:{id}`; `queue:updated` → `team:{teamId}` (old and
  new team when re-routed) on create, update and every message.
- **Internal-note leak test (required):** a client socket joined to the ticket must never receive an INTERNAL
  `message:new`, a staff `message:typing`, or any payload containing an internal note body; the client's messages
  endpoint and ticket preview never include INTERNAL content. Cover HTTP and sockets.

## Web (apps/web)

### Data layer (`lib/tickets/**`, `lib/realtime/**`, `lib/uploads/**`)

- TanStack Query hooks over `apiClient` (browser) with query keys under `['tickets', …]`: `useTicketFormConfig`,
  `useFormContext(requesterId?)`, `useRequesterSearch(search)`, `useTickets(query)` (infinite, cursor),
  `useTicketCounts`, `useTicket(ref)`, `useMessages(ticketId)`, `useMacros`, `useTeams`, `useCreateTicket`,
  `useSendMessage` (optimistic: append a pending message with a fresh `clientTempId` = crypto.randomUUID(); replace it
  by the server message; on failure mark it failed with Retry), `useUpdateTicket` (optimistic patch of the detail and
  every cached list/summary; rollback + toast on error).
- Realtime: one socket.io-client connection per tab (`NEXT_PUBLIC_API_URL`, path `/socket.io`, `auth: cb =>
getApiToken()`), reconnects with a fresh token after the server closes it (token expiry/revocation), only for ACTIVE
  verified users. `useTicketRoom(ticketId)` joins/leaves; on `message:new` insert into the messages cache (dedupe by id
  and clientTempId); on `ticket:updated` update detail + lists; on `queue:updated` invalidate lists/counts (debounced);
  after a reconnect refetch messages `after` the last known id and invalidate lists. Typing: `useTyping(ticketId)`
  (emit throttled, auto-stop after 4 s idle), render "{name} is typing…". **★** Rooms released and acquired in the
  same tick are sent as one batch, leaves before joins; `TOO_MANY_ROOMS` is retried after a leave (or a backoff),
  `RATE_LIMITED` with backoff 1 s → 30 s; other refusals are final for that holder. The portal list keeps
  `MAX_TICKET_ROOMS_PER_SOCKET − 10` live rows.
- Uploads: `uploadAttachment(file, {visibility, ticketId?, onProgress})` → presign → multipart POST to the returned URL
  (XHR for progress) → complete; client-side checks (allow-list, 25 MB each, 25 MB total, ≤ 10 files) before
  presigning. **★** `visibility` is required (`useAttachmentUploads({visibility, ticketId?})` too): the console's
  Internal note tab uses `internal`; Public reply, the portal reply and New ticket use `public`. A presign 429 with
  `details.reason: 'daily-quota'` fails as `quota` (the chip says when this file would fit); any other 429 as `busy`;
  a presign `file_too_large` as `allowance`. A finished chip takes the stored `fileName` / `mimeType`.
- `next.config.ts` CSP: add `NEXT_PUBLIC_UPLOAD_ORIGIN` to `connect-src` (and the API origin's ws/wss already there).

### Shared ticket UI (`components/tickets/**`) — design references in the design file

(`scratchpad`-free copy: open `design/Loons Help Desk_final.html`; the markup lines below refer to its template)

- `NewTicketModal` (design modal: requester select for staff with the client-org chip + contract badge for clients,
  Ticket type segmented radios, Security-incident checklist banner + category locked to Cybersecurity/SOC, subject,
  dependent Category → Sub-type selects, Priority radio cards with first-reply targets and "Auto-set from sub-type" /
  "Set manually" note + helper line, P1 red banner with "Call 24/7 SOC" (tel: socPhone), Impact segmented radios,
  Site/location (searchable, from form-context), Asset/device ID (mono, category placeholder), category custom fields
  (typed inputs, required markers), Description, drag-and-drop attachments with progress + remove, footer "Routed to
  <team> · Target first response <x>", error count, Cancel / Create ticket). Modal scale+fade; focus trap; validation
  with the shared zod schema + per-field errors like the design; on success toast "Ticket LG-n created · routed to
  <team>" and navigate to the ticket. Opened from the portal "+ New ticket" and the console menu.
- `TicketThread` + `MessageBubble` (author, role tag Client / Loons Support / Internal note, time, body with preserved
  line breaks and linkified URLs rendered safely, attachments chips with download), messages slide in (direction-aware),
  pending/failed states for optimistic messages, `TypingIndicator`, `SlaText` (list text/colour from `slaState`),
  `AttachmentDropzone`, `AttachmentChips`.

### Client portal (`app/(portal)/**`)

- `/tickets`: My tickets list (design) with All/Active/Solved tabs + counts, rows (subject, `LG-n · category` mono,
  preview, status pill, updated-ago), animated insert/reorder, skeletons, empty state; realtime refresh.
- `/tickets/[ref]`: thread page (design: back link, `LG-n · Category › Sub-type · Site` mono line, subject + status pill,
  "Handled by <assignee> (<team>) · Opened <date>" (**★** Arabic: `يتولاها <assignee> · <team>`, unassigned
  `يتولاها <team>`, since Arabic team
  names already carry the short name in parentheses), Mark as solved / Reopen button (optimistic), thread, reply composer
  with attachments; hint "Replying will reopen this ticket." when solved; typing indicator for agents' public typing is
  NOT shown (staff typing goes to the staff room only).

### Agent console (`app/(console)/**`)

- `/console/inbox?view=&team=&ticket=&q=` (URL state): Views + Teams columns with live counts, list sorted by SLA
  (toggle recent) with the design row (priority dot, requester · company, SLA text coloured by `slaState`, subject,
  `LG-n`, status pill, assignee initials), search from the top bar, conversation column (header line, subject +
  priority, thread incl. yellow internal notes, composer with Public reply / Internal note tabs (note composer yellow
  background), macros as buttons filling {{requesterFirstName}}/{{siteName}} and applying `setStatus`, Send & solve,
  Send reply / Add note, typing indicators; **★** the two tabs keep separate attachment lists and macro-armed
  statuses), right panel (SLA card with countdown + bar + resolution target, status segmented control (**★** a
  radiogroup with manual activation: arrows move focus, Space/Enter saves), Priority/Assignee/Category/Sub-type/
  Impact/Site/Asset ID/Tags editors — all optimistic,
  Assign to me, Requester card: name/email, client, contract badge, AMC expiry, sites covered, account manager, other
  tickets). Responsive like the design (views → select below ~1180 px; single pane below ~860 px).
- Keep `/console/queue`, `/console/customers`, `/console/reports` as they are (Phase 5).

### UX rules (spec §1)

Optimistic updates for replies, status, priority, assignee; Motion: modal scale+fade, list items animate in/out and
reorder with `layout`, status pill colour transitions, new chat messages slide in, side sheets from inline-end,
skeletons (no spinners); 150–250 ms ease-out; reduced motion respected; RTL mirroring. Tokens only; logical classes
only; every string EN + AR (namespaces: `tickets` for shared ticket UI + new-ticket modal, `portal`, `console`,
`validation` for new zod keys `validation.subjectRequired|descriptionMin|messageRequired|tagFormat`).

## Tests

- API: integration tests for every endpoint and rule above (permission matrix per role incl. cross-org and cross-team,
  404 for invisible tickets, create validation incl. security/custom fields/site/attachments, status machine, SLA due
  dates + pause/resume, idempotent messages, PATCH events, list filters/sort/pagination/counts, attachments with
  MinIO), realtime (joins, rooms, typing routing, emission after commit) and **the internal-note leak test**.
- Shared: SLA arithmetic (business hours, closed days, holidays, start outside hours, exact closing boundary,
  multi-day spans, round trip addSlaMinutes/slaMinutesBetween, a DST zone such as Europe/London), status rules.
- Web: unit/component tests for hooks' cache updates (optimistic + realtime dedupe), SLA text, the modal's dependent
  selects/priority/security behaviour, composer.
- E2E (Playwright, two browser contexts): **client creates a ticket in the portal → it appears in the agent's inbox
  in realtime → agent replies publicly → the client sees the reply without reload**; agent adds an internal note → the
  client never sees it (page + network); status change by the agent reflects on the client page; attachments upload
  (**★** incl. a JPEG named .png that is stored and downloaded as .jpg, and a note's file presigned `internal`).
