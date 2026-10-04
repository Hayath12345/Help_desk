// Phase 2 ticket API contract (request bodies, query strings and response DTOs). The API validates
// requests and serialises responses with these; the web app uses them for forms and typed fetches.
// Dates travel as ISO-8601 strings.

import { z } from 'zod';
import {
  CONTRACT_TYPES,
  CUSTOM_FIELD_TYPES,
  ESCALATION_CHANNELS,
  ESCALATION_TARGET_TYPES,
  IMPACTS,
  MESSAGE_TYPES,
  PRIORITIES,
  ROLES,
  SLA_TARGETS,
  TICKET_CHANNELS,
  TICKET_EVENT_TYPES,
  TICKET_STATUSES,
  TICKET_TYPES,
} from '../enums.ts';
import {
  CLIENT_TABS,
  STAFF_SETTABLE_STATUSES,
  STAFF_VIEWS,
  TICKET_LIST_SORTS,
} from '../tickets.ts';

const isoDate = z.iso.datetime({ offset: true });
const nullableIso = isoDate.nullable();

// ───────────── Limits ─────────────

export const TICKET_LIMITS = {
  subjectMax: 200,
  descriptionMin: 10,
  descriptionMax: 10_000,
  messageMax: 10_000,
  assetIdMax: 100,
  tagMax: 40,
  tagsPerTicket: 20,
  attachmentsPerRequest: 10,
  /** Spec §12: 25 MB per file. */
  attachmentMaxBytes: 25 * 1024 * 1024,
  /** Design: "Attachments are limited to 25 MB in total" per ticket/message. */
  attachmentsTotalMaxBytes: 25 * 1024 * 1024,
  listPageMax: 100,
} as const;

/**
 * MIME types accepted for attachments (spec §12: images, video, PDF, text/log, zip). The API
 * enforces them (presign + complete); the web checks them before uploading.
 */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'application/pdf',
  'text/plain',
  'text/x-log',
  'application/zip',
  'application/x-zip-compressed',
] as const;
export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

/**
 * Why `POST /attachments/:id/complete` refused a file (400 BAD_REQUEST with
 * `error.details = { reason }`), so clients can say which: `mismatch` — the stored object's size
 * or type differs from what was declared; `content` — its bytes are not a file of the declared
 * type (e.g. a JPEG or an executable named .png); `infected` — the virus scan refused it.
 */
export const UPLOAD_REJECTION_REASONS = ['mismatch', 'content', 'infected'] as const;
export type UploadRejectionReason = (typeof UPLOAD_REJECTION_REASONS)[number];
export const uploadRejectionDetailsSchema = z.object({ reason: z.enum(UPLOAD_REJECTION_REASONS) });
export type UploadRejectionDetails = z.infer<typeof uploadRejectionDetailsSchema>;

/**
 * Who an upload is for — chosen at presign and enforced when the file is linked: `public` files
 * can only be attached to a PUBLIC message or a new ticket's description, `internal` files only to
 * an INTERNAL note. Only staff may reserve `internal` uploads (a client gets 403). Linking a file to
 * a message of the other kind is refused (400), so a note's file can never be published, even by
 * a hand-written API call.
 */
export const ATTACHMENT_VISIBILITIES = ['public', 'internal'] as const;
export type AttachmentVisibility = (typeof ATTACHMENT_VISIBILITIES)[number];

/**
 * Upload budget per user over a rolling 24 hours, counted in declared bytes at presign (API env
 * `UPLOAD_DAILY_BYTES_PER_USER`, default 2 GiB). Beyond it presign answers 429 RATE_LIMITED with
 * `error.details` matching `uploadQuotaDetailsSchema`.
 */
export const DEFAULT_UPLOAD_DAILY_BYTES_PER_USER = 2 * 1024 * 1024 * 1024;
export const uploadQuotaDetailsSchema = z.object({
  reason: z.literal('daily-quota'),
  /** The configured budget in bytes. */
  limitBytes: z.number().int().positive(),
  /** When enough of the budget frees up for this file. */
  retryAfterSeconds: z.number().int().nonnegative(),
});
export type UploadQuotaDetails = z.infer<typeof uploadQuotaDetailsSchema>;

/**
 * File extensions that belong to each allowed MIME type (lower case; the first is canonical). The
 * API keeps an upload's extension only when it belongs to the declared type and otherwise appends
 * the canonical one ("Invoice.pdf.exe" declared as a PDF is stored as "Invoice.pdf.exe.pdf"), so
 * a downloaded file always opens as the type the allow-list admitted.
 */
export const UPLOAD_MIME_EXTENSIONS = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/heic': ['heic', 'heif'],
  'image/heif': ['heif', 'heic'],
  'image/bmp': ['bmp', 'dib'],
  'image/tiff': ['tif', 'tiff'],
  'video/mp4': ['mp4', 'm4v'],
  'video/quicktime': ['mov', 'qt'],
  'video/webm': ['webm'],
  'video/x-matroska': ['mkv'],
  'video/x-msvideo': ['avi'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'text'],
  'text/x-log': ['log', 'txt'],
  'application/zip': ['zip'],
  'application/x-zip-compressed': ['zip'],
} as const satisfies Record<AllowedUploadMimeType, readonly [string, ...string[]]>;

// ───────────── Free text ─────────────

/** C0 control characters except tab, line feed and carriage return, plus DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Removes control characters from user text: Postgres can't store NUL (a request carrying one
 * would fail), and the others are invisible. Tabs and line breaks stay. See also `toWellFormed`.
 */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

/**
 * Unpaired UTF-16 surrogates. With the `u` flag a valid surrogate pair is one code point (not in
 * the category), so only lone halves match.
 */
const LONE_SURROGATES = /\p{Cs}/gu;

/**
 * Replaces unpaired surrogates with U+FFFD, like `String.prototype.toWellFormed` (ES2024, hence
 * this helper): a lone surrogate can't be encoded as UTF-8 — a text column gets U+FFFD from the
 * driver, but jsonb (the ticket custom fields) refuses the value with a 500 (review RR-SEC-3).
 */
export function toWellFormed(value: string): string {
  return value.replace(LONE_SURROGATES, '�');
}

/**
 * A string with control characters removed and lone surrogates replaced, then trimmed (same type
 * for `.shape` reuse).
 */
export const cleanText = () =>
  z
    .string()
    .overwrite((value) => toWellFormed(stripControlChars(value)))
    .trim();

// ───────────── Shared fragments ─────────────

export const labelPairSchema = z.object({ labelEn: z.string(), labelAr: z.string() });

export const categoryRefSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  icon: z.string(),
  isActive: z.boolean(),
});
export const subtypeRefSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  isActive: z.boolean(),
});
export const teamRefSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  nameEn: z.string(),
  nameAr: z.string(),
});
export const orgRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
});
export const siteRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
});
export const userRefSchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * Team and site on a ticket (E6): `isActive` false when the team / site was archived after the
 * ticket was raised (the ticket still renders it, with an "archived" marker).
 */
export const ticketTeamRefSchema = teamRefSchema.extend({ isActive: z.boolean() });
export const ticketSiteRefSchema = siteRefSchema.extend({ isActive: z.boolean() });

// ───────────── New-ticket form configuration (live DB config) ─────────────

/** A dropdown / multi-select option as the New Ticket form sees it (active options only). */
export const customFieldOptionSchema = z.object({
  value: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
});

/**
 * An option as stored in `CustomField.options` (JSON). Options are archived one by one, never
 * removed (E5/E6): an archived option (`isActive: false`) is left out of the form but still labels
 * the values old tickets hold. Rows written before Phase 4 have no `isActive` (= active).
 */
export const storedCustomFieldOptionSchema = customFieldOptionSchema.extend({
  isActive: z.boolean().default(true),
});
export type StoredCustomFieldOption = z.infer<typeof storedCustomFieldOptionSchema>;

export const formCustomFieldSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(customFieldOptionSchema),
  placeholderEn: z.string().nullable(),
  placeholderAr: z.string().nullable(),
  required: z.boolean(),
});

export const formSubtypeSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  defaultPriority: z.enum(PRIORITIES),
});

export const formCategorySchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  icon: z.string(),
  assetPlaceholder: z.string().nullable(),
  /** Arabic example for the asset input; null = the English one is shown (bidi-isolated). */
  assetPlaceholderAr: z.string().nullable(),
  team: teamRefSchema,
  subtypes: z.array(formSubtypeSchema),
  fields: z.array(formCustomFieldSchema),
});

export const slaPolicyDtoSchema = z.object({
  priority: z.enum(PRIORITIES),
  firstReplyMins: z.number().int(),
  resolveMins: z.number().int(),
  businessHoursOnly: z.boolean(),
  /** Share of each window (percent, SLA time) after which a target is "at risk" (spec §7). */
  atRiskPercent: z.number().int().min(0).max(100),
});

/** GET /config/ticket-form — active categories (sorted), their sub-types and fields, SLA policies. */
export const ticketFormConfigSchema = z.object({
  categories: z.array(formCategorySchema),
  slaPolicies: z.array(slaPolicyDtoSchema),
  /** Category key forced for SECURITY_INCIDENT tickets (spec §7). */
  securityCategoryKey: z.string(),
  /** Shown in the P1 banner ("Call 24/7 SOC"). */
  socPhone: z.string().nullable(),
  /**
   * Length of a business day in minutes (the configured opening hours, E12): "N business days"
   * labels divide SLA minutes of business-hours policies by it. The most common length among the
   * open weekdays (the longer one on a tie).
   */
  businessDayMinutes: z.number().int().positive(),
  /**
   * The config generation this was read at (E18). Every admin change bumps it and broadcasts
   * `config:updated {scope, version}`; a client that receives version N and refetches keeps
   * refetching (with a small backoff) until this is ≥ N. 0 when the generation is unknown (Redis
   * unavailable).
   */
  version: z.number().int().nonnegative(),
});
export type TicketFormConfig = z.infer<typeof ticketFormConfigSchema>;

/**
 * GET /tickets/form-context?requesterId= — who the ticket is for. Clients omit requesterId (it is
 * always themselves); staff must pass the client they are raising the ticket for.
 */
export const formContextQuerySchema = z.object({ requesterId: z.uuid().optional() });
export const formContextSchema = z.object({
  requester: z.object({ id: z.uuid(), name: z.string(), email: z.email() }),
  org: orgRefSchema.extend({ contractType: z.enum(CONTRACT_TYPES) }),
  sites: z.array(siteRefSchema),
});
export type FormContext = z.infer<typeof formContextSchema>;

/** GET /requesters?search= — staff picker for "Requester" (active, verified clients). */
export const requesterSearchQuerySchema = z.object({
  search: cleanText().max(100).optional().default(''),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
export const requesterOptionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  org: orgRefSchema.extend({ contractType: z.enum(CONTRACT_TYPES) }),
});
export const requesterListSchema = z.object({ items: z.array(requesterOptionSchema) });

// ───────────── Create ticket ─────────────

/**
 * POST /tickets. The API rebuilds the full validation at request time from the live config:
 * category/sub-type active and related, SECURITY_INCIDENT ⇒ security category, required custom
 * fields present and typed, site belongs to the requester's org, attachments uploaded by the caller
 * and unattached.
 */
export const createTicketSchema = z.object({
  type: z.enum(TICKET_TYPES),
  categoryId: z.uuid(),
  subtypeId: z.uuid(),
  /** Omit to use the sub-type's default priority. */
  priority: z.enum(PRIORITIES).optional(),
  impact: z.enum(IMPACTS),
  siteId: z.uuid(),
  assetId: cleanText().max(TICKET_LIMITS.assetIdMax).optional(),
  subject: cleanText()
    .min(1, { error: 'validation.subjectRequired' })
    .max(TICKET_LIMITS.subjectMax, { error: 'validation.tooLong' }),
  description: cleanText()
    .min(TICKET_LIMITS.descriptionMin, { error: 'validation.descriptionMin' })
    .max(TICKET_LIMITS.descriptionMax, { error: 'validation.tooLong' }),
  /** Keyed by CustomField.key; values validated against the field type at request time. */
  customFields: z.record(z.string(), z.unknown()).default({}),
  attachmentIds: z.array(z.uuid()).max(TICKET_LIMITS.attachmentsPerRequest).default([]),
  /** Staff only (required for staff): the client the ticket is raised for. */
  requesterId: z.uuid().optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// ───────────── Ticket DTOs ─────────────

export const attachmentDtoSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: isoDate,
});
export type AttachmentDto = z.infer<typeof attachmentDtoSchema>;

export const messageAuthorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(ROLES),
});
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

export const messageDtoSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  type: z.enum(MESSAGE_TYPES),
  body: z.string(),
  /** null for SYSTEM messages (and authors that were removed). */
  author: messageAuthorSchema.nullable(),
  clientTempId: z.string().nullable(),
  attachments: z.array(attachmentDtoSchema),
  createdAt: isoDate,
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

export const ticketSummaryDtoSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  /** "LG-4817" */
  ref: z.string(),
  subject: z.string(),
  type: z.enum(TICKET_TYPES),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(PRIORITIES),
  impact: z.enum(IMPACTS),
  channel: z.enum(TICKET_CHANNELS),
  category: categoryRefSchema,
  subtype: subtypeRefSchema.nullable(),
  team: ticketTeamRefSchema,
  org: orgRefSchema,
  site: ticketSiteRefSchema.nullable(),
  requester: userRefSchema.extend({ email: z.email() }),
  assignee: userRefSchema.nullable(),
  tags: z.array(z.string()),
  /** Latest PUBLIC message, trimmed to ~140 characters (never an internal note). */
  preview: z.string(),
  firstReplyDueAt: nullableIso,
  resolveDueAt: nullableIso,
  /**
   * When `atRiskPercent` of each window has elapsed in SLA time (D1/D2), computed by the API with
   * the due dates. Compare with now (`slaState`); null = not known yet (never "at risk").
   */
  firstReplyAtRiskAt: nullableIso,
  resolveAtRiskAt: nullableIso,
  firstRepliedAt: nullableIso,
  solvedAt: nullableIso,
  /** Set by the auto-close job (SOLVED for tickets.autoCloseDays → CLOSED). */
  closedAt: nullableIso,
  /** A target has been breached (sticky: stays true after the target is met, for reporting). */
  slaBreached: z.boolean(),
  slaPausedAt: nullableIso,
  /** When the ticket became P1 (creation or a later upgrade); null while it is not P1. */
  p1Since: nullableIso,
  /** Last escalation step fired in the current P1 period (0 = none). */
  p1EscalationStep: z.number().int().nonnegative(),
  p1AckedAt: nullableIso,
  /** Who acknowledged the P1 (null when not acknowledged, or the user was removed). */
  p1AckedBy: userRefSchema.nullable(),
  /** Latest PUBLIC message (or the creation time). Internal notes don't move it. */
  lastMessageAt: nullableIso,
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type TicketSummaryDto = z.infer<typeof ticketSummaryDtoSchema>;

/**
 * A custom-field value on a ticket (E6), labelled even when the field or option was archived since.
 */
export const customFieldValueSchema = z.object({
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  value: z.unknown(),
  /** false: the field was archived after the value was set. */
  isActive: z.boolean(),
  /**
   * DROPDOWN / MULTI_SELECT: the chosen options in value order, with their labels (an option that
   * is no longer configured keeps its value as its label and `isActive: false`). null for other
   * types.
   */
  options: z.array(storedCustomFieldOptionSchema.extend({ isActive: z.boolean() })).nullable(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/** Requester card (design right panel): the client organisation and its contract. */
export const requesterCardSchema = z.object({
  org: orgRefSchema.extend({
    contractType: z.enum(CONTRACT_TYPES),
    amcExpiry: z.iso.date().nullable(),
  }),
  accountManager: userRefSchema.nullable(),
  sitesCount: z.number().int(),
  /** Other tickets (any status) raised by the same organisation. Staff only; 0 for clients. */
  otherTicketsCount: z.number().int(),
});

/** One step of a P1 escalation chain: it fires `afterMins` after the ticket became P1 (D3). */
export const p1ChainStepSchema = z.object({
  step: z.number().int().positive(),
  afterMins: z.number().int().nonnegative(),
});
export type P1ChainStep = z.infer<typeof p1ChainStepSchema>;

/**
 * The next P1 escalation step as the worker will fire it (Phase 5 F15): the first rule of the
 * chain in force that has not fired in the current P1 period — fired rules are read from the
 * period's escalation events, so an admin reorder mid-chain never shows (or pages) a rule twice.
 */
export const p1NextStepSchema = z.object({
  /** The step number it will be recorded as (`p1EscalationStep` after it fires). */
  step: z.number().int().positive(),
  /** The escalation rule that will fire, and its place in the chain now. */
  ruleId: z.uuid(),
  ruleStep: z.number().int().positive(),
  targetType: z.enum(ESCALATION_TARGET_TYPES),
  /** Minutes after `p1Since`. */
  afterMins: z.number().int().nonnegative(),
  /** `p1Since + afterMins` (in the past when it is overdue: it fires at once). */
  dueAt: isoDate,
});
export type P1NextStep = z.infer<typeof p1NextStepSchema>;

export const ticketDetailDtoSchema = ticketSummaryDtoSchema.extend({
  description: z.string(),
  assetId: z.string().nullable(),
  customFields: z.array(customFieldValueSchema),
  attachments: z.array(attachmentDtoSchema),
  requesterCard: requesterCardSchema,
  /** Policy windows used by the SLA card ("First reply due · 15 min", "Resolution target"). */
  sla: slaPolicyDtoSchema,
  /**
   * The active P1 escalation chain of the ticket's team (its own rules replace the global chain,
   * D3), ordered by step; staff only (null for clients). With `p1Since` and `p1EscalationStep`
   * the P1 banner shows "step N of M" and when the next step fires. Read when the detail is
   * loaded (the chain only changes with the Phase 4 admin).
   */
  p1Chain: z.array(p1ChainStepSchema).nullable(),
  /**
   * Staff only: the next escalation step the worker will fire (`p1NextStepSchema`); null for
   * clients, and when nothing more will fire — not a P1, no P1 period, acknowledged, solved /
   * closed, or every rule of the chain has fired.
   */
  p1NextStep: p1NextStepSchema.nullable(),
});
export type TicketDetailDto = z.infer<typeof ticketDetailDtoSchema>;

// ───────────── List / counts ─────────────

/** `assigneeId=none`: tickets nobody is assigned to (Team queue "Unassigned" filter). */
export const UNASSIGNED_FILTER = 'none';

/**
 * Staff filters of GET /tickets and GET /tickets/queue-counts (Phase 5 F4, F9). Each one is ANDed
 * onto what the caller may see (never widening it); clients' requests ignore them.
 */
export const ticketFilterFieldsSchema = z.object({
  teamId: z.uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  categoryId: z.uuid().optional(),
  /** A staff member's id, or `none` for unassigned tickets. */
  assigneeId: z.union([z.uuid(), z.literal(UNASSIGNED_FILTER)]).optional(),
  /** The client organisation ("company view", F9). */
  orgId: z.uuid().optional(),
  requesterId: z.uuid().optional(),
  search: cleanText().max(100).optional(),
});
export type TicketFilterFields = z.infer<typeof ticketFilterFieldsSchema>;

/**
 * GET /tickets
 * - Clients: `tab` (all|active|solved) over tickets they requested (`scope=mine`, default) or their
 *   whole organisation (`scope=org`).
 * - Staff: `view` (mine|unassigned|risk|p1|open|solved), `teamId` and the Phase 5 filters
 *   (`priority`, `categoryId`, `assigneeId` — `none` = unassigned —, `orgId`, `requesterId`), all
 *   ANDed within what they may see.
 * `search` matches subject, LG number, requester name/email. `sort=sla` (default for staff):
 * solved last, then first-reply pending before replied, then the next due date ascending.
 * `sort=priority`: solved last, then P1 → P4, then the next due date ascending, then created.
 * `sort=recent`: most recently updated first.
 */
export const listTicketsQuerySchema = ticketFilterFieldsSchema.extend({
  view: z.enum(STAFF_VIEWS).optional(),
  tab: z.enum(CLIENT_TABS).optional(),
  scope: z.enum(['mine', 'org']).optional(),
  sort: z.enum(TICKET_LIST_SORTS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_LIMITS.listPageMax).optional().default(50),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

export const ticketListSchema = z.object({
  items: z.array(ticketSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});
export type TicketList = z.infer<typeof ticketListSchema>;

/** GET /tickets/counts — sidebar/tab counts for the caller. */
export const ticketCountsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('staff'),
    views: z.object({
      mine: z.number().int(),
      unassigned: z.number().int(),
      risk: z.number().int(),
      p1: z.number().int(),
      open: z.number().int(),
      solved: z.number().int(),
    }),
    teams: z.array(teamRefSchema.extend({ count: z.number().int() })),
  }),
  z.object({
    kind: z.literal('client'),
    tabs: z.object({ all: z.number().int(), active: z.number().int(), solved: z.number().int() }),
  }),
]);
export type TicketCounts = z.infer<typeof ticketCountsSchema>;

// ───────────── Messages ─────────────

/** GET /tickets/:id/messages?after= — ascending; clients never receive INTERNAL messages. */
export const listMessagesQuerySchema = z.object({
  /** Message id: return only messages created after it (reconnect catch-up). */
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});
export const messageListSchema = z.object({ items: z.array(messageDtoSchema) });

/**
 * POST /tickets/:id/messages. Idempotent on (ticketId, clientTempId): a retry returns the stored
 * message. Clients may only post PUBLIC; `andSolve` (staff "Send & solve") solves after replying.
 */
export const createMessageSchema = z.object({
  type: z.enum(['PUBLIC', 'INTERNAL']),
  body: cleanText()
    .min(1, { error: 'validation.messageRequired' })
    .max(TICKET_LIMITS.messageMax, { error: 'validation.tooLong' }),
  clientTempId: z.uuid(),
  attachmentIds: z.array(z.uuid()).max(TICKET_LIMITS.attachmentsPerRequest).default([]),
  andSolve: z.boolean().optional().default(false),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const createMessageResponseSchema = z.object({
  message: messageDtoSchema,
  ticket: ticketSummaryDtoSchema,
});

// ───────────── Update ticket ─────────────

/**
 * PATCH /tickets/:id — staff may change any of these; clients may only send
 * `{ status: 'SOLVED' }` (active → solved) or `{ status: 'OPEN' }` (solved → reopen).
 * Every change writes a TicketEvent. `assigneeId` must be active staff on the ticket's team (or a
 * super admin); `null` unassigns. Changing the category re-routes to its team and requires a
 * matching `subtypeId`. Changing the priority recomputes the SLA due dates and at-risk instants
 * from `createdAt` with the new policy; time the ticket already spent PENDING stays credited to
 * the resolution target (`computeSlaTargets` with the ticket's finished pauses). Becoming P1
 * starts a new P1 period (`p1Since` = now, escalation step 0, not acknowledged); leaving P1 clears
 * it.
 */
export const updateTicketSchema = z
  .object({
    status: z.enum(STAFF_SETTABLE_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: z.uuid().nullable().optional(),
    categoryId: z.uuid().optional(),
    subtypeId: z.uuid().optional(),
    impact: z.enum(IMPACTS).optional(),
    siteId: z.uuid().optional(),
    assetId: cleanText().max(TICKET_LIMITS.assetIdMax).nullable().optional(),
    tags: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9][a-z0-9-]*$/u, { error: 'validation.tagFormat' })
          .max(TICKET_LIMITS.tagMax),
      )
      .max(TICKET_LIMITS.tagsPerTicket)
      .optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { error: 'validation.required' });
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const ticketResponseSchema = z.object({ ticket: ticketDetailDtoSchema });

// ───────────── P1 acknowledge ─────────────

/**
 * POST /tickets/:id/acknowledge (staff who can view the ticket; body-less). Idempotent: when the
 * P1 was already acknowledged the answer is still 200 with `alreadyAcknowledged: true`, and the
 * ticket shows the first acknowledger (`p1AckedBy` / `p1AckedAt`), never the caller.
 */
export const acknowledgeTicketResponseSchema = z.object({
  ticket: ticketDetailDtoSchema,
  alreadyAcknowledged: z.boolean(),
});
export type AcknowledgeTicketResponse = z.infer<typeof acknowledgeTicketResponseSchema>;

// ───────────── Attachments ─────────────

/**
 * POST /attachments/presign — reserve an upload (Attachment row, status PENDING). The stored name
 * keeps its extension only if it belongs to the MIME type (else the canonical one is appended).
 */
export const presignAttachmentSchema = z.object({
  /**
   * Control characters removed and lone surrogates replaced (a browser sends `File.name` as is,
   * and NTFS allows unpaired surrogates): the API stores and signs a well-formed name.
   */
  fileName: cleanText().min(1).max(255),
  mimeType: z.string().trim().min(1).max(127),
  sizeBytes: z.number().int().min(1).max(TICKET_LIMITS.attachmentMaxBytes),
  /** Set when adding to an existing ticket (reply); omit while creating a ticket. */
  ticketId: z.uuid().optional(),
  /** `internal` for a staff member's note (see ATTACHMENT_VISIBILITIES). */
  visibility: z.enum(ATTACHMENT_VISIBILITIES).default('public'),
});
export const presignAttachmentResponseSchema = z.object({
  attachmentId: z.uuid(),
  /** Browser POSTs multipart form data (fields + file last) straight to storage. */
  upload: z.object({ url: z.url(), fields: z.record(z.string(), z.string()) }),
  expiresAt: isoDate,
});

/**
 * POST /attachments/:id/complete — storage verified (size/type), the checked object copied to a
 * key only the API writes, its first bytes matched against the type, scan hook run on the copy.
 * An image whose bytes are a different allowed image type (a JPEG named .png) is accepted as what
 * it really is: the returned attachment carries the detected `mimeType` and a matching extension
 * in `fileName`. Content that is no allowed image is still refused (`content`).
 */
export const completeAttachmentResponseSchema = z.object({ attachment: attachmentDtoSchema });

/** GET /attachments/:id/download — short-lived signed URL (caller must be able to see it). */
export const attachmentDownloadSchema = z.object({ url: z.url(), expiresAt: isoDate });

// ───────────── Staff helpers ─────────────

/** GET /macros — global macros plus those of the caller's teams, sorted. */
export const macroDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  teamId: z.uuid().nullable(),
  titleEn: z.string(),
  titleAr: z.string(),
  /** May contain {{requesterFirstName}} and {{siteName}}, filled in by the composer. */
  bodyEn: z.string(),
  bodyAr: z.string(),
  setStatus: z.enum(TICKET_STATUSES).nullable(),
});
export const macroListSchema = z.object({ items: z.array(macroDtoSchema) });
export type MacroDto = z.infer<typeof macroDtoSchema>;

/** GET /teams — active teams with their active staff (assignee picker, Teams sidebar). */
export const teamWithMembersSchema = teamRefSchema.extend({
  members: z.array(userRefSchema.extend({ role: z.enum(ROLES) })),
});
export const teamListSchema = z.object({ items: z.array(teamWithMembersSchema) });
export type TeamWithMembers = z.infer<typeof teamWithMembersSchema>;

/** `:ref` path param: a ticket uuid or its "LG-4817" / "4817" number. */
export const ticketRefParamSchema = z.object({ ref: z.string().trim().min(1).max(64) });
export const idParamSchema = z.object({ id: z.uuid() });

// ───────────── Activity timeline (Phase 5 F14) ─────────────

/**
 * One side (before / after) of a ticket event, with ids resolved to labels — archived teams,
 * categories, sub-types, sites and disabled users included (`isActive` false). `removed`: the id
 * no longer exists (a deleted user). `text`: the asset id, or a stored value the API could not
 * read as its type.
 */
export const ticketEventValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), value: z.enum(TICKET_STATUSES) }),
  z.object({ kind: z.literal('priority'), value: z.enum(PRIORITIES) }),
  z.object({ kind: z.literal('impact'), value: z.enum(IMPACTS) }),
  z.object({
    kind: z.literal('user'),
    id: z.uuid(),
    name: z.string(),
    /** false: the account is disabled or awaiting approval now. */
    isActive: z.boolean(),
  }),
  z.object({ kind: z.literal('team'), ...ticketTeamRefSchema.shape }),
  z.object({ kind: z.literal('category'), ...categoryRefSchema.shape }),
  z.object({ kind: z.literal('subtype'), ...subtypeRefSchema.shape }),
  z.object({ kind: z.literal('site'), ...ticketSiteRefSchema.shape }),
  /** An escalation step number (ESCALATED from / to). */
  z.object({ kind: z.literal('step'), value: z.number().int().nonnegative() }),
  /** The full tag set (TAGS_CHANGED from / to). */
  z.object({ kind: z.literal('tags'), value: z.array(z.string()) }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  z.object({
    kind: z.literal('removed'),
    entity: z.enum(['user', 'team', 'category', 'subtype', 'site']),
    id: z.string(),
  }),
]);
export type TicketEventValue = z.infer<typeof ticketEventValueSchema>;

/**
 * Event details, by type (only these keys are ever sent):
 * - CREATED: `priority`, `type`, `channel`, `category`, `subtype` (resolved like from / to);
 * - TAGS_CHANGED: `added`, `removed`;
 * - CUSTOM_FIELDS_CHANGED: `fields` (the changed fields, labelled; values are never copied);
 * - FIRST_REPLY: `minutesToFirstReply` (wall clock);
 * - SLA_AT_RISK / SLA_BREACHED: `target`, `dueAt`;
 * - ESCALATED: `step`, `targetType`, `channels`;
 * - P1_ACKNOWLEDGED: `step`, `minutesToAcknowledge`;
 * - AUTO_CLOSED: `days` (the auto-close setting then).
 */
export const ticketEventMetaSchema = z.object({
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  category: ticketEventValueSchema.optional(),
  subtype: ticketEventValueSchema.optional(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  fields: z
    .array(
      z.object({
        key: z.string(),
        labelEn: z.string(),
        labelAr: z.string(),
        isActive: z.boolean(),
      }),
    )
    .optional(),
  minutesToFirstReply: z.number().optional(),
  target: z.enum(SLA_TARGETS).optional(),
  dueAt: isoDate.optional(),
  step: z.number().int().nonnegative().optional(),
  targetType: z.enum(ESCALATION_TARGET_TYPES).optional(),
  channels: z.array(z.enum(ESCALATION_CHANNELS)).optional(),
  minutesToAcknowledge: z.number().nullable().optional(),
  days: z.number().optional(),
  /** ASSIGNEE_CHANGED: the system picked the assignee from the category's skills. */
  auto: z.boolean().optional(),
});
export type TicketEventMeta = z.infer<typeof ticketEventMetaSchema>;

export const ticketEventDtoSchema = z.object({
  id: z.uuid(),
  type: z.enum(TICKET_EVENT_TYPES),
  /** Who made the change; null for the system (SLA worker, escalation, auto-close). */
  actor: messageAuthorSchema.nullable(),
  from: ticketEventValueSchema.nullable(),
  to: ticketEventValueSchema.nullable(),
  meta: ticketEventMetaSchema,
  createdAt: isoDate,
});
export type TicketEventDto = z.infer<typeof ticketEventDtoSchema>;

/** GET /tickets/:id/events — staff only, newest first, cursor-paged. */
export const ticketEventsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});
export type TicketEventsQuery = z.infer<typeof ticketEventsQuerySchema>;

export const ticketEventListSchema = z.object({
  items: z.array(ticketEventDtoSchema),
  nextCursor: z.string().nullable(),
});
export type TicketEventList = z.infer<typeof ticketEventListSchema>;
