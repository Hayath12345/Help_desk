// Admin — Macros (spec §10.8; decision E7). Super admins manage every macro; team leads only the
// macros of teams they lead (never global ones, never moved to another team or to global:
// `canManageMacros`, `canMoveMacro`).
//
// GET    /admin/macros?status=&teamId=              → { items: MacroAdminDto[] } (team leads: their teams)
// POST   /admin/macros                              → 201 { item }
// PATCH  /admin/macros/:id                          → { item }
// POST   /admin/macros/:id/archive | /restore       → { item }
// POST   /admin/macros/reorder                      → 204 (within one scope: a team or global)
// Scope `macros`.

import { z } from 'zod';
import { TICKET_STATUSES } from '../../enums.ts';
import { STAFF_SETTABLE_STATUSES } from '../../tickets.ts';
import {
  NOTHING_TO_CHANGE,
  adminKeySchema,
  adminListQuerySchema,
  adminTeamRefSchema,
  adminUserRefSchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
  reorderBodySchema,
} from './common.ts';
import { cleanText } from '../tickets.ts';

/** Placeholders the composer fills in (`{{requesterFirstName}}`); anything else is refused. */
export const MACRO_VARIABLES = ['requesterFirstName', 'siteName'] as const;
export type MacroVariable = (typeof MACRO_VARIABLES)[number];

export const MACRO_BODY_MAX = 10_000;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Placeholders in `text` that are not MACRO_VARIABLES (in order of appearance, unique). */
export function unknownMacroVariables(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!(MACRO_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

const knownVariablesOnly = (text: string) => unknownMacroVariables(text).length === 0;
/** Bodies may use MACRO_VARIABLES only (`validation.unknownVariable`). */
const UNKNOWN_VARIABLE = { error: 'validation.unknownVariable' } as const;

const macroBody = cleanText()
  .min(1, { error: 'validation.required' })
  .max(MACRO_BODY_MAX, { error: 'validation.tooLong' })
  .refine(knownVariablesOnly, UNKNOWN_VARIABLE);

/** The Arabic body may be '' (the English one is used). */
const macroBodyAr = cleanText()
  .max(MACRO_BODY_MAX, { error: 'validation.tooLong' })
  .refine(knownVariablesOnly, UNKNOWN_VARIABLE);

export const macroAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  /** null = global (every team). */
  teamId: z.uuid().nullable(),
  team: adminTeamRefSchema.nullable(),
  titleEn: z.string(),
  titleAr: z.string(),
  bodyEn: z.string(),
  bodyAr: z.string(),
  setStatus: z.enum(TICKET_STATUSES).nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdBy: adminUserRefSchema.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type MacroAdminDto = z.infer<typeof macroAdminDtoSchema>;

export const macroListQuerySchema = adminListQuerySchema.extend({
  /** A team id, or `global`; omitted = every macro the caller may manage. */
  teamId: z.union([z.uuid(), z.literal('global')]).optional(),
});
export const macroAdminListSchema = itemListSchema(macroAdminDtoSchema);
export const macroResponseSchema = itemResponseSchema(macroAdminDtoSchema);

export const createMacroSchema = z.object({
  key: adminKeySchema.optional(),
  /** null = global (super admins only). */
  teamId: z.uuid().nullable(),
  titleEn: labelEnSchema,
  titleAr: labelArSchema.default(''),
  bodyEn: macroBody,
  bodyAr: macroBodyAr.default(''),
  setStatus: z.enum(STAFF_SETTABLE_STATUSES).nullable().default(null),
});
export type CreateMacroInput = z.infer<typeof createMacroSchema>;

export const updateMacroSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    /** Moving between teams / global: super admins only. */
    teamId: z.uuid().nullable().optional(),
    titleEn: labelEnSchema.optional(),
    titleAr: labelArSchema.optional(),
    bodyEn: macroBody.optional(),
    bodyAr: macroBodyAr.optional(),
    setStatus: z.enum(STAFF_SETTABLE_STATUSES).nullable().optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateMacroInput = z.infer<typeof updateMacroSchema>;

/** Reorders the macros of one scope: a team (`teamId`) or the global ones (`null`). */
export const reorderMacrosSchema = reorderBodySchema.safeExtend({ teamId: z.uuid().nullable() });
export type ReorderMacrosInput = z.infer<typeof reorderMacrosSchema>;
