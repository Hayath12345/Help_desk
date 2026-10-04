'use client';

// Data of the Skills section (API: /admin/skills, contract packages/shared/src/schemas/admin/
// skills.ts). Writes refresh the `skills` scope: the Skills list plus the Staff and Categories
// lists that show skills and their counts (lib/realtime/config-scopes.ts).

import { skillAdminListSchema, skillResponseSchema, type SkillAdminDto } from '@loons/shared';
import type { z } from 'zod';
import { adminListFetcher, adminPath, adminWrite, useAdminList } from '@/lib/admin';

export type SkillList = z.output<typeof skillAdminListSchema>;

/** Every skill, archived ones included: the table's "Show archived" switch hides them. */
export const SKILL_LIST_PARAMS = { status: 'all' } as const;

export function useSkillList() {
  return useAdminList({
    section: 'skills',
    params: SKILL_LIST_PARAMS,
    queryFn: adminListFetcher('skills', skillAdminListSchema, { params: SKILL_LIST_PARAMS }),
  });
}

export const skillsApi = {
  create: async (body: unknown): Promise<SkillAdminDto> =>
    (await adminWrite('POST', adminPath('skills'), body, skillResponseSchema)).item,
  update: async (id: string, body: unknown): Promise<SkillAdminDto> =>
    (await adminWrite('PATCH', adminPath('skills', id), body, skillResponseSchema)).item,
  setActive: async (
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<SkillAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('skills', id, active ? 'restore' : 'archive'),
        { expectedUpdatedAt },
        skillResponseSchema,
      )
    ).item,
};
