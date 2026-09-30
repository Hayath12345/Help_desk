// Admin — Categories & sub-types (spec §10.1; decisions E4, E5, E6, E16).
//
// GET    /admin/categories?status=                      → { items: CategoryAdminDto[] }
// POST   /admin/categories                              → 201 { item }   (with its first sub-type)
// PATCH  /admin/categories/:id                          → { item }
// POST   /admin/categories/:id/archive | /restore       → { item }
// POST   /admin/categories/reorder                      → 204
// PUT    /admin/categories/:id/fields                   → { item }   (linked custom fields, ordered)
// POST   /admin/categories/:id/subtypes                 → 201 { item: SubtypeAdminDto }
// PATCH  /admin/categories/:id/subtypes/:subtypeId      → { item: SubtypeAdminDto }
// POST   /admin/categories/:id/subtypes/:subtypeId/archive | /restore → { item: SubtypeAdminDto }
// POST   /admin/categories/:id/subtypes/reorder         → 204
// Scope `ticket-form` after every write. Guards (E5): the security category and its last active
// sub-type can't be archived; a category routes only to an active team.

import { z } from 'zod';
import { CUSTOM_FIELD_TYPES, PRIORITIES } from '../../enums.ts';
import {
  NOTHING_TO_CHANGE,
  adminKeySchema,
  adminTeamRefSchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
  optionalText,
  adminListQuerySchema,
} from './common.ts';

/**
 * Icons a category may use (lucide names; the seeded ones first). Stored values outside this list
 * (older rows) still render; new choices come from here.
 */
export const CATEGORY_ICONS = [
  'shield-alert',
  'network',
  'server',
  'cloud',
  'cctv',
  'key-round',
  'siren',
  'building-complex',
  'monitor-speaker',
  'app-window',
  'briefcase-business',
  'circle-question-mark',
  'wifi',
  'router',
  'database',
  'hard-drive',
  'cpu',
  'laptop',
  'printer',
  'phone',
  'camera',
  'lock',
  'flame',
  'thermometer',
  'wrench',
  'headset',
  'mail',
  'globe',
  'bell',
  'file-text',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];
export const DEFAULT_CATEGORY_ICON: CategoryIcon = 'circle-question-mark';

/**
 * 409 `guard` codes of this section (E5): the security category (`tickets.securityCategoryKey`)
 * and its last active sub-type can't be archived; an archived category can't be restored while its
 * team is archived (route it to an active team first).
 */
export const CATEGORY_GUARDS = [
  'security_category',
  'security_category_last_subtype',
  'category_team_archived',
] as const;
export type CategoryGuard = (typeof CATEGORY_GUARDS)[number];

export const ASSET_PLACEHOLDER_MAX = 100;
/** Custom fields linked to one category. */
export const CATEGORY_FIELDS_MAX = 30;

/**
 * Why an active-looking category is not on the New Ticket form: archived, no active sub-type (a
 * sub-type is required, so the form leaves it out), or its team is archived.
 */
export const CATEGORY_HIDDEN_REASONS = ['archived', 'no_active_subtype', 'team_archived'] as const;
export type CategoryHiddenReason = (typeof CATEGORY_HIDDEN_REASONS)[number];

export const subtypeAdminDtoSchema = z.object({
  id: z.uuid(),
  categoryId: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  defaultPriority: z.enum(PRIORITIES),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SubtypeAdminDto = z.infer<typeof subtypeAdminDtoSchema>;

/** A custom field linked to the category (CategoryField), in form order. */
export const categoryFieldLinkSchema = z.object({
  fieldId: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});

export const categoryAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  icon: z.string(),
  assetPlaceholder: z.string().nullable(),
  assetPlaceholderAr: z.string().nullable(),
  team: adminTeamRefSchema,
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  /** Its key is `tickets.securityCategoryKey` (can't be archived, E5). */
  isSecurityCategory: z.boolean(),
  /** null when the category is on the New Ticket form. */
  hiddenReason: z.enum(CATEGORY_HIDDEN_REASONS).nullable(),
  /** Every sub-type, archived ones included, in order. */
  subtypes: z.array(subtypeAdminDtoSchema),
  fields: z.array(categoryFieldLinkSchema),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CategoryAdminDto = z.infer<typeof categoryAdminDtoSchema>;

export const categoryListQuerySchema = adminListQuerySchema;
export const categoryListSchema = itemListSchema(categoryAdminDtoSchema);
export const categoryResponseSchema = itemResponseSchema(categoryAdminDtoSchema);
export const subtypeResponseSchema = itemResponseSchema(subtypeAdminDtoSchema);

export const createSubtypeSchema = z.object({
  /** Generated from `labelEn` when omitted (unique within the category, archived included). */
  key: adminKeySchema.optional(),
  labelEn: labelEnSchema,
  labelAr: labelArSchema.default(''),
  defaultPriority: z.enum(PRIORITIES).default('P3'),
});
export type CreateSubtypeInput = z.infer<typeof createSubtypeSchema>;

const uniqueIds = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.duplicateValue' });

/** A category is created with its first sub-type (E5): without one it never appears on the form. */
export const createCategorySchema = z.object({
  key: adminKeySchema.optional(),
  labelEn: labelEnSchema,
  labelAr: labelArSchema.default(''),
  icon: z.enum(CATEGORY_ICONS).default(DEFAULT_CATEGORY_ICON),
  assetPlaceholder: optionalText(ASSET_PLACEHOLDER_MAX).default(null),
  assetPlaceholderAr: optionalText(ASSET_PLACEHOLDER_MAX).default(null),
  /** An active team. */
  teamId: z.uuid(),
  firstSubtype: createSubtypeSchema,
  /** Custom fields to link, in form order. */
  fieldIds: uniqueIds(CATEGORY_FIELDS_MAX).default([]),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    labelEn: labelEnSchema.optional(),
    labelAr: labelArSchema.optional(),
    icon: z.enum(CATEGORY_ICONS).optional(),
    assetPlaceholder: optionalText(ASSET_PLACEHOLDER_MAX).optional(),
    assetPlaceholderAr: optionalText(ASSET_PLACEHOLDER_MAX).optional(),
    /** Re-routes new tickets only; existing tickets keep their team. */
    teamId: z.uuid().optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const updateSubtypeSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    labelEn: labelEnSchema.optional(),
    labelAr: labelArSchema.optional(),
    defaultPriority: z.enum(PRIORITIES).optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateSubtypeInput = z.infer<typeof updateSubtypeSchema>;

/** PUT /admin/categories/:id/fields — the linked fields in form order (the category's updatedAt). */
export const setCategoryFieldsSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  fieldIds: uniqueIds(CATEGORY_FIELDS_MAX),
});
export type SetCategoryFieldsInput = z.infer<typeof setCategoryFieldsSchema>;

export const categorySubtypeParamSchema = z.object({ id: z.uuid(), subtypeId: z.uuid() });
