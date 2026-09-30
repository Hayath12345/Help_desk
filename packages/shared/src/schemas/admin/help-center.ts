// Admin — Help center (spec §10.10; decision E15). The portal page stays Phase 5.
//
// GET    /admin/help-center?status=                 → { items: HelpArticleAdminDto[] }
// POST   /admin/help-center                         → 201 { item }
// PATCH  /admin/help-center/:id                     → { item } (publish / unpublish: isPublished)
// POST   /admin/help-center/:id/archive | /restore  → { item }
// POST   /admin/help-center/reorder                 → 204
// Scope `help-center`.

import { z } from 'zod';
import {
  NOTHING_TO_CHANGE,
  adminKeySchema,
  adminListQuerySchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  itemListSchema,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
  longTextOptionalSchema,
  longTextSchema,
} from './common.ts';

export const helpArticleAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  titleEn: z.string(),
  titleAr: z.string(),
  bodyEn: z.string(),
  bodyAr: z.string(),
  sortOrder: z.number().int(),
  isPublished: z.boolean(),
  isActive: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type HelpArticleAdminDto = z.infer<typeof helpArticleAdminDtoSchema>;

export const helpArticleListQuerySchema = adminListQuerySchema;
export const helpArticleListSchema = itemListSchema(helpArticleAdminDtoSchema);
export const helpArticleResponseSchema = itemResponseSchema(helpArticleAdminDtoSchema);

export const createHelpArticleSchema = z.object({
  key: adminKeySchema.optional(),
  titleEn: labelEnSchema,
  titleAr: labelArSchema.default(''),
  bodyEn: longTextSchema,
  bodyAr: longTextOptionalSchema.default(''),
  /** New articles start as drafts unless published straight away. */
  isPublished: z.boolean().default(false),
});
export type CreateHelpArticleInput = z.infer<typeof createHelpArticleSchema>;

export const updateHelpArticleSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    titleEn: labelEnSchema.optional(),
    titleAr: labelArSchema.optional(),
    bodyEn: longTextSchema.optional(),
    bodyAr: longTextOptionalSchema.optional(),
    isPublished: z.boolean().optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateHelpArticleInput = z.infer<typeof updateHelpArticleSchema>;
