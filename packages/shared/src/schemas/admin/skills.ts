// Admin — Skills (decision: skills-based auto-assignment; docs/AUTO_ASSIGN.md). Super admins only.
// A skill is a thing staff can be good at ("Network", "CCTV"). Categories list the skills they need
// (`PUT /admin/categories/:id/skills`), staff list the skills they have (`PUT /admin/staff/:id/skills`).
//
// GET    /admin/skills?status=&search=              → { items: SkillAdminDto[] } (by English label)
// POST   /admin/skills                              → 201 { item }
// PATCH  /admin/skills/:id                          → { item }   (labels; the key never changes)
// POST   /admin/skills/:id/archive | /restore       → { item }
// Scope `skills`. An archived skill stays on the staff and categories that have it but no longer
// counts for matching (docs/AUTO_ASSIGN.md); it can't be picked for new links.

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
} from './common.ts';

/** Skills one staff member or one category may carry. */
export const SKILLS_PER_LINK_MAX = 30;

/** A skill as other admin rows show it (staff, categories). */
export const skillRefSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  labelEn: z.string(),
  labelAr: z.string(),
  isActive: z.boolean(),
});
export type SkillRef = z.infer<typeof skillRefSchema>;

export const skillAdminDtoSchema = skillRefSchema.extend({
  /** Staff who have the skill (active accounts only). */
  staffCount: z.number().int().nonnegative(),
  /** Categories that need the skill (active ones only). */
  categoryCount: z.number().int().nonnegative(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SkillAdminDto = z.infer<typeof skillAdminDtoSchema>;

export const skillListQuerySchema = adminListQuerySchema;
export const skillAdminListSchema = itemListSchema(skillAdminDtoSchema);
export const skillResponseSchema = itemResponseSchema(skillAdminDtoSchema);

export const createSkillSchema = z.object({
  key: adminKeySchema.optional(),
  labelEn: labelEnSchema,
  labelAr: labelArSchema.default(''),
});
export type CreateSkillInput = z.infer<typeof createSkillSchema>;

export const updateSkillSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    labelEn: labelEnSchema.optional(),
    labelAr: labelArSchema.optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

/**
 * Body of `PUT /admin/staff/:id/skills` and `PUT /admin/categories/:id/skills`: the complete list
 * (replaces the current one; [] clears it). Only active skills may be added; an archived skill
 * that is already linked may stay in the list.
 */
export const setSkillsSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  skillIds: z
    .array(z.uuid())
    .max(SKILLS_PER_LINK_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.duplicateValue' }),
});
export type SetSkillsInput = z.infer<typeof setSkillsSchema>;
