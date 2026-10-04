'use client';

// The skills catalog the pickers of the Staff and Categories sheets choose from (API:
// GET /admin/skills, contract packages/shared/src/schemas/admin/skills.ts). It lives under the
// `skills` admin keys, so a write to skills, staff or categories (scope `skills`) refreshes it.

import { skillAdminListSchema, type SkillRef } from '@loons/shared';
import { adminListFetcher, useAdminList } from '@/lib/admin';

/** Only active skills can be picked for a new link (archived ones may stay where they are). */
export const ACTIVE_SKILLS_PARAMS = { status: 'active' } as const;

export function useActiveSkills(enabled = true) {
  return useAdminList({
    section: 'skills',
    params: ACTIVE_SKILLS_PARAMS,
    queryFn: adminListFetcher('skills', skillAdminListSchema, { params: ACTIVE_SKILLS_PARAMS }),
    enabled,
  });
}

/** Skill ids in one canonical order, so an unchanged selection compares (and dirty-checks) equal. */
export function sortedSkillIds(skills: readonly Pick<SkillRef, 'id'>[] | undefined): string[] {
  return [...new Set((skills ?? []).map((skill) => skill.id))].sort();
}

/** Whether two id lists hold the same skills, whatever their order. */
export function sameSkillIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
