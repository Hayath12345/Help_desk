'use client';

// Data of the Macros section (API: /admin/macros, contract packages/shared/src/schemas/admin/
// macros.ts). Writes refresh the `macros` scope (the console's macro list included).

import {
  macroAdminListSchema,
  macroResponseSchema,
  staffDirectorySchema,
  type MacroAdminDto,
  type Role,
} from '@loons/shared';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  adminGet,
  adminKeys,
  adminListFetcher,
  adminPath,
  adminWrite,
  useAdminList,
} from '@/lib/admin';
import { useTeams } from '@/lib/tickets/queries';

export type MacroList = z.output<typeof macroAdminListSchema>;

/** 'all' (every macro the viewer manages), 'global', or a team id. */
export type MacroScopeFilter = string;

export const macroListParams = (scope: MacroScopeFilter) =>
  ({ status: 'all', ...(scope === 'all' ? {} : { teamId: scope }) }) as const;

export function useMacroList(scope: MacroScopeFilter) {
  const params = macroListParams(scope);
  return useAdminList({
    section: 'macros',
    params,
    queryFn: adminListFetcher('macros', macroAdminListSchema, { params }),
  });
}

export interface ScopeTeam {
  id: string;
  nameEn: string;
  nameAr: string;
}

/**
 * The teams whose macros the viewer manages (E7): every active team for a super admin; for a
 * team lead, the teams they lead (from the staff directory, which lists memberships).
 */
export function useMacroTeams(
  role: Role,
  userId: string,
): {
  teams: ScopeTeam[];
  isPending: boolean;
} {
  const teams = useTeams();
  const isLead = role === 'TEAM_LEAD';
  const params = { role: 'TEAM_LEAD', limit: 500 } as const;
  const directory = useQuery({
    queryKey: adminKeys.staffDirectory(params),
    queryFn: ({ signal }) =>
      adminGet('/admin/staff-directory', staffDirectorySchema, { params, signal }),
    enabled: isLead,
    staleTime: 60_000,
  });
  const all = teams.data ?? [];
  if (!isLead) return { teams: all, isPending: teams.isPending };
  const self = directory.data?.items.find((entry) => entry.id === userId);
  const led = new Set(
    (self?.teams ?? []).filter((m) => m.memberRole === 'LEAD').map((m) => m.teamId),
  );
  return {
    teams: all.filter((team) => led.has(team.id)),
    isPending: teams.isPending || directory.isPending,
  };
}

export const macrosApi = {
  create: async (body: unknown): Promise<MacroAdminDto> =>
    (await adminWrite('POST', adminPath('macros'), body, macroResponseSchema)).item,
  update: async (id: string, body: unknown): Promise<MacroAdminDto> =>
    (await adminWrite('PATCH', adminPath('macros', id), body, macroResponseSchema)).item,
  setActive: async (
    id: string,
    active: boolean,
    expectedUpdatedAt: string,
  ): Promise<MacroAdminDto> =>
    (
      await adminWrite(
        'POST',
        adminPath('macros', id, active ? 'restore' : 'archive'),
        { expectedUpdatedAt },
        macroResponseSchema,
      )
    ).item,
  reorder: (body: { teamId: string | null; ids: string[]; expectedIds: string[] }) =>
    adminWrite('POST', adminPath('macros', 'reorder'), body),
};
