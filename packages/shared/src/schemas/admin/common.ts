// Phase 4 admin API contract — fragments shared by every section (decisions E4, E5, E17, E19, E20).
//
// Conventions for every section (`packages/shared/src/schemas/admin/<section>.ts`):
// - Routes live under `/admin/<section>` (Bearer auth, OpenAPI tag `admin`).
// - Lists: `GET /admin/<section>` → `{ items }` (small config sets) or `{ items, nextCursor }`
//   (organisations, staff, sign-ups, audit log). `status` = active (default) | archived | all.
// - Create: `POST /admin/<section>` → 201 `{ item }`. Keys are optional: when omitted the API
//   generates one from the English label (E4); a key is immutable once created.
// - Update: `PATCH /admin/<section>/:id` with `expectedUpdatedAt` (the `updatedAt` the edit started
//   from) → `{ item }`, or 409 CONFLICT `{ reason: 'stale' }` when someone else saved first (E19).
// - Archive / restore: `POST /admin/<section>/:id/archive|restore` with `expectedUpdatedAt`
//   → `{ item }`; an archive guard refuses with 409 `{ reason: 'guard', guard }` (E5).
// - Reorder: `POST /admin/<section>/reorder` (or a nested `…/reorder`) with the order the client
//   started from (`expectedIds`) and the new order (`ids`) → 204; 409 `{ reason: 'order_changed' }`
//   when the current order is not `expectedIds` any more (E3).
// - Errors: 400 VALIDATION_FAILED (details: issues), 401, 403, 404, 409 CONFLICT (details:
//   `adminConflictDetailsSchema`), 429 RATE_LIMITED (per-user admin write limit).
// Error messages are i18n keys under the web's `validation` namespace.

import { z } from 'zod';
import { cleanText, siteRefSchema, teamRefSchema, userRefSchema } from '../tickets.ts';

export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDay = z.iso.date();

export const ADMIN_LIMITS = {
  keyMin: 2,
  keyMax: 64,
  labelMax: 120,
  /** Placeholders, job titles, short notes. */
  shortTextMax: 200,
  addressMax: 300,
  /** Email template bodies, help articles, macro bodies. */
  longTextMax: 20_000,
  searchMax: 100,
  pageDefault: 50,
  pageMax: 100,
  /** Rows in one reorder request. */
  reorderMax: 500,
} as const;

// ───────────── Keys (E4) ─────────────

/** A stable key: lower-case letters and digits in groups joined by single `-` or `_`. */
export const ADMIN_KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const adminKeySchema = z
  .string()
  .trim()
  .min(ADMIN_LIMITS.keyMin, { error: 'validation.keyFormat' })
  .max(ADMIN_LIMITS.keyMax, { error: 'validation.keyFormat' })
  .regex(ADMIN_KEY_PATTERN, { error: 'validation.keyFormat' });

/**
 * The key suggested for a label (E4): ASCII letters and digits of the English label, accents
 * dropped, other characters collapsed into `separator`, at most `maxLength` characters (cut at a
 * separator when possible). '' when nothing usable is left (e.g. an Arabic-only label): the API
 * then falls back to `<entity>-<random>`. The API adds `-2`, `-3`… on a collision with any row,
 * archived ones included.
 */
export function slugifyKey(
  label: string,
  options: { separator?: '-' | '_'; maxLength?: number } = {},
): string {
  const separator = options.separator ?? '-';
  const maxLength = Math.max(ADMIN_LIMITS.keyMin, options.maxLength ?? 48);
  const slug = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, 'g'), '');
  if (slug.length <= maxLength) return slug.length >= ADMIN_LIMITS.keyMin ? slug : '';
  const cut = slug.slice(0, maxLength);
  const lastSeparator = cut.lastIndexOf(separator);
  const trimmed = lastSeparator >= ADMIN_LIMITS.keyMin ? cut.slice(0, lastSeparator) : cut;
  return trimmed.replace(new RegExp(`\\${separator}+$`), '');
}

// ───────────── Text ─────────────

/**
 * Unicode bidi embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). Labels
 * never need them (the UI sets `dir` on every bilingual field), and a stored override can make a
 * name display reversed next to ticket data ("‮gnp.exe" shows as "exe.png").
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** Removes bidi embedding / override / isolate controls (see BIDI_CONTROLS). */
export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROLS, '');
}

/**
 * Invisible format characters a label never needs: zero-width space, LRM / RLM, the Arabic letter
 * mark, word joiner and invisible operators, BOM, and C1 controls (U+0080–U+009F). ZWNJ / ZWJ
 * (U+200C / U+200D) stay: Arabic, Persian and emoji text use them between visible characters.
 */
const INVISIBLE_FORMAT = /[\u0080-\u009f\u061c\u200b\u200e\u200f\u2060-\u2064\ufeff]/g;

/** Nothing but whitespace and invisible format / control characters (e.g. a lone ZWJ). */
const NOTHING_VISIBLE = /^[\s\p{Cf}\p{Cc}]*$/u;

/**
 * A label as stored: bidi controls and invisible format characters removed, and '' when nothing
 * visible is left — so "required" means something the admin can see in a list or picker.
 */
function visibleText(value: string): string {
  const text = stripBidiControls(value).replace(INVISIBLE_FORMAT, '');
  return NOTHING_VISIBLE.test(text) ? '' : text;
}

/**
 * Short admin-authored text shown in lists and pickers (labels, names): cleanText without bidi
 * controls or invisible format characters, '' when nothing visible is left (review shared-db-3).
 */
export const labelText = () => cleanText().overwrite(visibleText).trim();

/** English label: required (the fallback everywhere, spec §11). */
export const labelEnSchema = labelText()
  .min(1, { error: 'validation.required' })
  .max(ADMIN_LIMITS.labelMax, { error: 'validation.tooLong' });

/** Arabic label: may be '' (the UI then shows the English one with a hint, E2). */
export const labelArSchema = labelText().max(ADMIN_LIMITS.labelMax, {
  error: 'validation.tooLong',
});

/** Optional free text: '' and null both mean "none" (stored as null). */
export const optionalText = (max: number = ADMIN_LIMITS.shortTextMax) =>
  labelText()
    .max(max, { error: 'validation.tooLong' })
    .nullable()
    .transform((value) => (value === '' ? null : value));

/** Required long text (bodies). */
export const longTextSchema = cleanText()
  .min(1, { error: 'validation.required' })
  .max(ADMIN_LIMITS.longTextMax, { error: 'validation.tooLong' });

/** Optional long text ('' allowed: the Arabic body of a bilingual pair). */
export const longTextOptionalSchema = cleanText().max(ADMIN_LIMITS.longTextMax, {
  error: 'validation.tooLong',
});

// ───────────── Concurrency, archive, reorder ─────────────

/** The `updatedAt` the edit started from (E19). */
export const expectedUpdatedAtSchema = isoDateTime;

/** Body of archive / restore actions. */
export const archiveBodySchema = z.object({ expectedUpdatedAt: expectedUpdatedAtSchema });
export type ArchiveBody = z.infer<typeof archiveBodySchema>;

/**
 * Refuses an update body that changes nothing (only `expectedUpdatedAt`): 400
 * `validation.nothingToChange`.
 */
export function hasChanges(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([k, v]) => k !== 'expectedUpdatedAt' && v !== undefined);
}
export const NOTHING_TO_CHANGE = { error: 'validation.nothingToChange' } as const;

/**
 * One reorder request per drop (E3): the order the client started from and the new order (a
 * permutation of it). The API refuses with 409 `order_changed` when the current order differs from
 * `expectedIds` (someone added, archived or moved a row meanwhile).
 */
export const reorderBodySchema = z
  .object({
    expectedIds: z.array(z.uuid()).min(1).max(ADMIN_LIMITS.reorderMax),
    ids: z.array(z.uuid()).min(1).max(ADMIN_LIMITS.reorderMax),
  })
  .superRefine((value, ctx) => {
    const expected = new Set(value.expectedIds);
    const next = new Set(value.ids);
    if (expected.size !== value.expectedIds.length || next.size !== value.ids.length) {
      ctx.addIssue({ code: 'custom', path: ['ids'], message: 'validation.duplicateValue' });
      return;
    }
    if (expected.size !== next.size || value.ids.some((id) => !expected.has(id))) {
      ctx.addIssue({ code: 'custom', path: ['ids'], message: 'validation.reorderMismatch' });
    }
  });
export type ReorderBody = z.infer<typeof reorderBodySchema>;

export const adminIdParamSchema = z.object({ id: z.uuid() });

// ───────────── Lists ─────────────

export const ADMIN_LIST_STATUSES = ['active', 'archived', 'all'] as const;
export type AdminListStatus = (typeof ADMIN_LIST_STATUSES)[number];

export const adminListQuerySchema = z.object({
  status: z.enum(ADMIN_LIST_STATUSES).default('active'),
  search: cleanText().max(ADMIN_LIMITS.searchMax).optional(),
});
export type AdminListQuery = z.infer<typeof adminListQuerySchema>;

export const adminPagedQuerySchema = adminListQuerySchema.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIMITS.pageMax)
    .optional()
    .default(ADMIN_LIMITS.pageDefault),
});
export type AdminPagedQuery = z.infer<typeof adminPagedQuerySchema>;

export const itemListSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
export const pagedListSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export const itemResponseSchema = <T extends z.ZodType>(item: T) => z.object({ item });

// ───────────── Refs ─────────────

/** A team as other admin rows show it (archived teams stay visible, E6). */
export const adminTeamRefSchema = teamRefSchema.extend({ isActive: z.boolean() });
export type AdminTeamRef = z.infer<typeof adminTeamRefSchema>;
export const adminSiteRefSchema = siteRefSchema.extend({ isActive: z.boolean() });
/** A user shown on an admin row (creator, target, account manager…). */
export const adminUserRefSchema = userRefSchema;

// ───────────── Errors ─────────────

/**
 * `error.details.reason` of a 409 CONFLICT from `/admin/*`:
 * - `stale`: `expectedUpdatedAt` is not the row's `updatedAt` any more ("Someone else changed this
 *   — reload"); `currentUpdatedAt` is set.
 * - `duplicate`: a unique key or value is taken (`fields`); `existingId` / `existingIsActive` when
 *   the API knows the row (e.g. an archived holiday or escalation step to restore instead).
 * - `in_use`: another row still references this one (a foreign key).
 * - `order_changed`: a reorder's `expectedIds` is not the current order.
 * - `guard`: an archive / change guard (E5, E9), named by `guard` (see ADMIN_GUARDS).
 */
export const ADMIN_CONFLICT_REASONS = [
  'stale',
  'duplicate',
  'in_use',
  'order_changed',
  'guard',
] as const;
export type AdminConflictReason = (typeof ADMIN_CONFLICT_REASONS)[number];

/**
 * Guards named by the contract (sections may add their own codes):
 * team_has_active_categories, team_has_open_tickets, team_in_escalation (E5); security_category,
 * security_category_last_subtype (E5); self_role, self_disable, last_super_admin (E9).
 */
export const ADMIN_GUARDS = [
  'team_has_active_categories',
  'team_has_open_tickets',
  'team_in_escalation',
  'security_category',
  'security_category_last_subtype',
  'self_role',
  'self_disable',
  'last_super_admin',
] as const;
export type AdminGuard = (typeof ADMIN_GUARDS)[number];

export const adminConflictDetailsSchema = z.object({
  reason: z.enum(ADMIN_CONFLICT_REASONS),
  currentUpdatedAt: isoDateTime.optional(),
  fields: z.array(z.string()).optional(),
  existingId: z.string().optional(),
  existingIsActive: z.boolean().optional(),
  guard: z.string().optional(),
});
export type AdminConflictDetails = z.infer<typeof adminConflictDetailsSchema>;
