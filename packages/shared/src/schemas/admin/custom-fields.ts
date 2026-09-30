// Admin — Custom fields (spec §10.2; decisions E4, E5, E6).
//
// GET    /admin/custom-fields?status=                  → { items: CustomFieldAdminDto[] }
// POST   /admin/custom-fields                          → 201 { item }
// PATCH  /admin/custom-fields/:id                      → { item }
// POST   /admin/custom-fields/:id/archive | /restore   → { item }
// Scope `ticket-form`. The key never changes after creation (ticket values are keyed by it); the
// type only while no ticket holds a value (409 guard `field_type_in_use`). Dropdown / multi-select
// options are archived one by one (`isActive: false`); an option a ticket holds can't be removed
// (409 guard `option_in_use`), so old tickets keep their labels (E6). Linking to categories:
// `categoryIds` here or PUT /admin/categories/:id/fields (per-category order).

import { z } from 'zod';
import { CUSTOM_FIELD_TYPES, type CustomFieldType } from '../../enums.ts';
import {
  NOTHING_TO_CHANGE,
  ADMIN_KEY_PATTERN,
  adminKeySchema,
  adminListQuerySchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
  optionalText,
} from './common.ts';

/** Types whose values come from `options`. */
export const OPTION_FIELD_TYPES = [
  'DROPDOWN',
  'MULTI_SELECT',
] as const satisfies readonly CustomFieldType[];

export function hasOptions(type: CustomFieldType): boolean {
  return (OPTION_FIELD_TYPES as readonly CustomFieldType[]).includes(type);
}

export const CUSTOM_FIELD_LIMITS = { optionsMax: 100, placeholderMax: 200, categoriesMax: 50 };

/**
 * 409 `guard` codes of this section: the type can't change while a ticket holds a value; an
 * option a ticket holds can't be removed (archive it instead).
 */
export const CUSTOM_FIELD_GUARDS = ['field_type_in_use', 'option_in_use'] as const;
export type CustomFieldGuard = (typeof CUSTOM_FIELD_GUARDS)[number];

/** An option value: a key-like string, unique within the field. */
export const customFieldOptionValueSchema = z
  .string()
  .trim()
  .min(1, { error: 'validation.required' })
  .max(64, { error: 'validation.keyFormat' })
  .regex(ADMIN_KEY_PATTERN, { error: 'validation.keyFormat' });

export const customFieldOptionInputSchema = z.object({
  value: customFieldOptionValueSchema,
  labelEn: labelEnSchema,
  labelAr: labelArSchema.default(''),
  isActive: z.boolean().default(true),
});
export type CustomFieldOptionInput = z.infer<typeof customFieldOptionInputSchema>;

export const customFieldOptionAdminSchema = z.object({
  value: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  isActive: z.boolean(),
});

export const customFieldAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  /** Every option, archived ones included (empty for types without options). */
  options: z.array(customFieldOptionAdminSchema),
  placeholderEn: z.string().nullable(),
  placeholderAr: z.string().nullable(),
  required: z.boolean(),
  isActive: z.boolean(),
  /** Categories it is linked to, with its position in each. */
  categories: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      labelEn: z.string(),
      labelAr: z.string(),
      isActive: z.boolean(),
      sortOrder: z.number().int(),
    }),
  ),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CustomFieldAdminDto = z.infer<typeof customFieldAdminDtoSchema>;

export const customFieldListQuerySchema = adminListQuerySchema;
export const customFieldListSchema = itemListSchema(customFieldAdminDtoSchema);
export const customFieldResponseSchema = itemResponseSchema(customFieldAdminDtoSchema);

const optionsSchema = z
  .array(customFieldOptionInputSchema)
  .max(CUSTOM_FIELD_LIMITS.optionsMax)
  .superRefine((options, ctx) => {
    const seen = new Set<string>();
    options.forEach((option, i) => {
      if (seen.has(option.value)) {
        ctx.addIssue({ code: 'custom', path: [i, 'value'], message: 'validation.duplicateValue' });
      }
      seen.add(option.value);
    });
  });

const categoryIdsSchema = z
  .array(z.uuid())
  .max(CUSTOM_FIELD_LIMITS.categoriesMax)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.duplicateValue' });

/**
 * Option rules for a type: DROPDOWN / MULTI_SELECT need at least one active option; other types
 * take none. Returns the i18n key of the problem, or null.
 */
export function customFieldOptionsProblem(
  type: CustomFieldType,
  options: ReadonlyArray<{ isActive?: boolean }>,
): 'validation.optionsRequired' | 'validation.optionsNotAllowed' | null {
  if (hasOptions(type)) {
    return options.some((o) => o.isActive !== false) ? null : 'validation.optionsRequired';
  }
  return options.length === 0 ? null : 'validation.optionsNotAllowed';
}

export const createCustomFieldSchema = z
  .object({
    /** Generated from `labelEn` with `_` separators when omitted. */
    key: adminKeySchema.optional(),
    labelEn: labelEnSchema,
    labelAr: labelArSchema.default(''),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema.default([]),
    placeholderEn: optionalText(CUSTOM_FIELD_LIMITS.placeholderMax).default(null),
    placeholderAr: optionalText(CUSTOM_FIELD_LIMITS.placeholderMax).default(null),
    required: z.boolean().default(false),
    /** Categories to link it to (appended last in each). */
    categoryIds: categoryIdsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    const problem = customFieldOptionsProblem(value.type, value.options);
    if (problem) ctx.addIssue({ code: 'custom', path: ['options'], message: problem });
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

/**
 * `options` replaces the list: an option a ticket holds must still be there (archive it with
 * `isActive: false` instead); the API checks it against the field's (new) type. `type` changes
 * only while no ticket holds a value for the field.
 */
export const updateCustomFieldSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    type: z.enum(CUSTOM_FIELD_TYPES).optional(),
    labelEn: labelEnSchema.optional(),
    labelAr: labelArSchema.optional(),
    options: optionsSchema.optional(),
    placeholderEn: optionalText(CUSTOM_FIELD_LIMITS.placeholderMax).optional(),
    placeholderAr: optionalText(CUSTOM_FIELD_LIMITS.placeholderMax).optional(),
    required: z.boolean().optional(),
    /** Replaces the linked categories (kept positions stay, new links go last). */
    categoryIds: categoryIdsSchema.optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
