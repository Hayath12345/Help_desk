'use client';

import { teamAdminListSchema, type TeamAdminDto } from '@loons/shared';
import { AlertTriangle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  adminListFetcher,
  adminPath,
  adminWrite,
  reorderById,
  useAdminList,
  useAdminMutation,
} from '@/lib/admin';
import { teamName } from '@/lib/tickets/labels';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '../../kit';
import type { AdminSectionProps } from '../types';
import { TeamSheet } from './team-sheet';

type SheetState = { mode: 'create' } | { mode: 'edit'; id: string; fallback?: TeamAdminDto };

const LIST_PARAMS = { status: 'all' } as const;
type TeamList = { items: TeamAdminDto[] };

/**
 * Teams & members (spec §10.3; E5, E7). Super Admins see every team, create, reorder, archive and
 * edit everything; team leads see the teams they lead and manage their members and on-call user
 * (the API returns only their teams and refuses anything else).
 */
export default function TeamsSection({ role }: AdminSectionProps) {
  const t = useTranslations('admin-people.teams');
  const tKit = useTranslations('admin.kit');
  const tCommon = useTranslations('admin-people.common');
  const tSections = useTranslations('admin.sections');
  const locale = useLocale();
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const list = useAdminList({
    section: 'teams',
    params: LIST_PARAMS,
    queryFn: adminListFetcher('teams', teamAdminListSchema, { params: LIST_PARAMS }),
  });
  const teams = list.data?.items;
  const takenKeys = useMemo(() => (teams ?? []).map((team) => team.key), [teams]);

  const reorder = useAdminMutation<{ ids: string[]; expectedIds: string[] }, undefined, TeamList>({
    section: 'teams',
    scopes: ['teams'],
    mutationFn: (body) => adminWrite('POST', adminPath('teams', 'reorder'), body),
    optimistic: (cached, { ids }) => ({
      items: reorderById(cached.items, ids, (team) => team.id),
    }),
    success: tKit('toast.reordered'),
    errorToast: true,
  });

  const current =
    sheet?.mode === 'edit'
      ? (teams?.find((team) => team.id === sheet.id) ?? sheet.fallback)
      : undefined;
  // The open team left the list (a lead lost the role, the team is gone): the sheet closes for
  // good, so it does not pop open again by itself if the team comes back later. (State adjusted
  // while rendering, the React way for state derived from props.)
  const gone = sheet?.mode === 'edit' && teams !== undefined && current === undefined;
  if (gone) setSheet(null);

  const columns: AdminTableColumn<TeamAdminDto>[] = [
    {
      id: 'name',
      header: t('table.name'),
      width: 'minmax(0,2fr)',
      cell: (team) => teamName(team, locale),
    },
    {
      id: 'members',
      header: t('table.members'),
      cell: (team) => t('table.memberCount', { count: team.members.length }),
    },
    {
      id: 'onCall',
      header: t('table.onCall'),
      width: 'minmax(0,1.5fr)',
      cell: (team) =>
        team.onCallUser ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{team.onCallUser.name}</span>
            {!team.onCallUser.phoneValid || !team.onCallUser.isActive ? (
              <AlertTriangle
                role="img"
                aria-label={t('form.onCallPhoneMissing', { name: team.onCallUser.name })}
                className="size-3.5 shrink-0 text-warning-strong"
              />
            ) : null}
          </span>
        ) : (
          <span className="text-ink-muted">{t('form.onCallNone')}</span>
        ),
    },
    {
      id: 'emails',
      header: t('table.emails'),
      hideOnMobile: true,
      cell: (team) => t('table.emailCount', { count: team.emails.length }),
    },
    {
      id: 'webhook',
      header: t('table.webhook'),
      hideOnMobile: true,
      width: 'minmax(0,1.5fr)',
      cell: (team) =>
        team.teamsWebhook.configured ? (
          <span dir="ltr" className="truncate">
            {team.teamsWebhook.host}
          </span>
        ) : (
          <span className="text-ink-muted">{tCommon('notSet')}</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader
        section="teams"
        actions={
          isSuperAdmin ? <CreateNewButton onClick={() => setSheet({ mode: 'create' })} /> : null
        }
      />
      <AdminTable
        label={tSections('teams.title')}
        columns={columns}
        rows={teams}
        getRowId={(team) => team.id}
        getRowLabel={(team) => teamName(team, locale)}
        isArchived={(team) => !team.isActive}
        onRowClick={(team) => setSheet({ mode: 'edit', id: team.id })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        {...(isSuperAdmin ? { showArchived, onShowArchivedChange: setShowArchived } : {})}
        empty={{
          title: t('empty'),
          ...(isSuperAdmin ? {} : { description: t('emptyLead') }),
        }}
        reorder={
          isSuperAdmin
            ? {
                onReorder: (ids, expectedIds) => reorder.mutate({ ids, expectedIds }),
                disabled: reorder.isPending,
              }
            : undefined
        }
      />
      <WhoCanSeeNote audience="teamLeads" />
      <TeamSheet
        open={sheet !== null && (sheet.mode === 'create' || current !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        mode={sheet?.mode ?? 'create'}
        team={current}
        isSuperAdmin={isSuperAdmin}
        takenKeys={takenKeys}
        onCreated={(team) => setSheet({ mode: 'edit', id: team.id, fallback: team })}
        onReload={async () =>
          sheet?.mode === 'edit'
            ? (await list.refetch()).data?.items.find((team) => team.id === sheet.id)
            : undefined
        }
      />
    </div>
  );
}
