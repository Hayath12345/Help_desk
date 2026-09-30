'use client';

import type { Locale, MacroAdminDto } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '@/components/admin/kit';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { reorderById, useAdminMutation } from '@/lib/admin';
import { localizedLabel, teamName } from '@/lib/tickets/labels';
import type { AdminSectionProps } from '../types';
import { macrosApi, useMacroList, useMacroTeams, type MacroList } from './data';
import { GLOBAL, MacroSheet } from './macro-sheet';

type SheetState = { key: number; id: string | null } | null;

const ALL = 'all';

/**
 * Macros (spec §10.8; E1, E3, E7): canned replies for the console composer. Super admins manage
 * global macros and every team's; team leads only their teams' (the API enforces it). Reordering
 * works within one scope — pick "Global" or a team in the filter first.
 */
export default function MacrosSection({ role, userId }: AdminSectionProps) {
  const t = useTranslations('admin-setup.macros');
  const tAdmin = useTranslations('admin');
  const tKit = useTranslations('admin.kit');
  const tStatus = useTranslations('common.status');
  const locale = useLocale() as Locale;
  const filterId = useId();
  const isSuperAdmin = role === 'SUPER_ADMIN';
  const [scope, setScope] = useState(ALL);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { teams, isPending: teamsPending } = useMacroTeams(role, userId);
  const list = useMacroList(scope);
  const rows = list.data?.items;

  const open = (id: string | null) => {
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, id }));
    setSheetOpen(true);
  };

  const reorder = useAdminMutation<
    { teamId: string | null; ids: string[]; expectedIds: string[] },
    unknown,
    MacroList
  >({
    section: 'macros',
    scopes: ['macros'],
    mutationFn: (body) => macrosApi.reorder(body),
    optimistic: (cached, { ids }) => ({ items: reorderById(cached.items, ids, (m) => m.id) }),
    success: tKit('toast.reordered'),
  });

  const columns = useMemo<AdminTableColumn<MacroAdminDto>[]>(
    () => [
      {
        id: 'title',
        header: t('columns.title'),
        width: 'minmax(0,2fr)',
        cell: (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">
              {localizedLabel({ labelEn: row.titleEn, labelAr: row.titleAr }, locale)}
            </span>
            <span dir="ltr" className="w-fit truncate font-mono text-xs font-normal text-ink-muted">
              {row.key}
            </span>
          </span>
        ),
      },
      {
        id: 'scope',
        header: t('columns.scope'),
        cell: (row) => (
          <span className="truncate">{row.team ? teamName(row.team, locale) : t('global')}</span>
        ),
      },
      {
        id: 'status',
        header: t('columns.setStatus'),
        width: '140px',
        cell: (row) => (row.setStatus ? tStatus(row.setStatus) : '—'),
      },
      {
        id: 'body',
        header: t('columns.body'),
        width: 'minmax(0,2fr)',
        hideOnMobile: true,
        cell: (row) => (
          <span className="truncate">
            {locale === 'ar' && row.bodyAr.trim() ? row.bodyAr : row.bodyEn}
          </span>
        ),
      },
    ],
    [t, tStatus, locale],
  );

  const scopeOptions = [
    { value: ALL, label: isSuperAdmin ? t('filter.all') : t('filter.allMine') },
    ...(isSuperAdmin ? [{ value: GLOBAL, label: t('global') }] : []),
    ...teams.map((team) => ({ value: team.id, label: teamName(team, locale) })),
  ];
  const canReorder = scope !== ALL;
  const editing = sheet?.id ? rows?.find((row) => row.id === sheet.id) : undefined;
  const takenKeys = useMemo(() => (rows ?? []).map((row) => row.key), [rows]);
  const defaultScope = scope !== ALL ? scope : isSuperAdmin ? GLOBAL : (teams[0]?.id ?? '');
  const noTeams = !isSuperAdmin && !teamsPending && teams.length === 0;

  return (
    <>
      <AdminSectionHeader
        section="macros"
        actions={<CreateNewButton onClick={() => open(null)} disabled={noTeams} />}
      />
      <AdminTable<MacroAdminDto>
        label={tAdmin('sections.macros.title')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.titleEn}
        isArchived={(row) => !row.isActive}
        onRowClick={(row) => open(row.id)}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        toolbar={
          <div className="flex items-center gap-2">
            <label htmlFor={filterId} className="text-[13px] text-ink-secondary">
              {t('filter.label')}
            </label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id={filterId} size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {scopeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        empty={{
          title: noTeams ? t('noTeamsTitle') : t('emptyTitle'),
          description: noTeams ? t('noTeamsDescription') : t('emptyDescription'),
        }}
        reorder={
          canReorder
            ? {
                onReorder: (ids, expectedIds) =>
                  reorder.mutate({ teamId: scope === GLOBAL ? null : scope, ids, expectedIds }),
                disabled: reorder.isPending,
              }
            : undefined
        }
      />
      {!canReorder ? <p className="text-[13px] text-ink-muted">{t('reorderHint')}</p> : null}
      <WhoCanSeeNote audience="teamLeads">{t('whoCanSee')}</WhoCanSeeNote>
      {sheet && (sheet.id === null || editing) ? (
        <MacroSheet
          key={sheet.key}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          macro={editing}
          role={role}
          teams={teams}
          defaultScope={defaultScope}
          takenKeys={takenKeys}
          reload={async () => {
            const fresh = await list.refetch();
            return fresh.data?.items.find((row) => row.id === sheet.id);
          }}
        />
      ) : null}
    </>
  );
}
