'use client';

import type { CategoryAdminDto, Locale } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '@/components/admin/kit';
import { reorderById, useAdminMutation } from '@/lib/admin';
import { localizedLabel, teamName } from '@/lib/tickets/labels';
import type { AdminSectionProps } from '../types';
import { CategorySheet } from './category-sheet';
import { categoriesApi, useCategoryList, type CategoryList } from './data';
import { CategoryIcon } from './setup-shared';

type SheetState = { key: number; id: string | null } | null;

/**
 * Categories & sub-types (spec §10.1; E1, E3, E4, E5, E16): the plain table (drag or Move up /
 * down to reorder the New Ticket form's categories), "Create new", and the wide sheet with the
 * sub-types, linked fields and the live preview. Super admins only.
 */
export default function CategoriesSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-setup.categories');
  const tAdmin = useTranslations('admin');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as Locale;
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useCategoryList();
  const rows = list.data?.items;

  const open = (id: string | null) => {
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, id }));
    setSheetOpen(true);
  };

  const reorder = useAdminMutation<{ ids: string[]; expectedIds: string[] }, unknown, CategoryList>(
    {
      section: 'categories',
      scopes: ['ticket-form'],
      mutationFn: (body) => categoriesApi.reorder(body),
      optimistic: (cached, { ids }) => ({ items: reorderById(cached.items, ids, (c) => c.id) }),
      success: tKit('toast.reordered'),
    },
  );

  const columns = useMemo<AdminTableColumn<CategoryAdminDto>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        width: 'minmax(0,2fr)',
        cell: (row) => (
          <span className="flex min-w-0 items-center gap-2.5">
            <CategoryIcon name={row.icon} className="size-4 shrink-0 text-ink-secondary" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{localizedLabel(row, locale)}</span>
              <span
                dir="ltr"
                className="w-fit truncate font-mono text-xs font-normal text-ink-muted"
              >
                {row.key}
              </span>
            </span>
          </span>
        ),
      },
      {
        id: 'team',
        header: t('columns.team'),
        cell: (row) => (
          <span className="truncate">
            {row.team.isActive
              ? teamName(row.team, locale)
              : t('archivedTeam', { team: teamName(row.team, locale) })}
          </span>
        ),
      },
      {
        id: 'subtypes',
        header: t('columns.subtypes'),
        width: '110px',
        cell: (row) => row.subtypes.filter((s) => s.isActive).length,
      },
      {
        id: 'fields',
        header: t('columns.fields'),
        width: '110px',
        hideOnMobile: true,
        cell: (row) => row.fields.filter((f) => f.isActive).length,
      },
      {
        id: 'form',
        header: t('columns.onForm'),
        width: 'minmax(0,1.2fr)',
        cell: (row) =>
          row.hiddenReason === null ? (
            <span>{t('onForm')}</span>
          ) : row.hiddenReason === 'archived' ? (
            <span className="text-ink-muted">—</span>
          ) : (
            <span className="text-status-pending-fg">{t(`hiddenShort.${row.hiddenReason}`)}</span>
          ),
      },
    ],
    [t, locale],
  );

  const editing = sheet?.id ? rows?.find((row) => row.id === sheet.id) : undefined;
  const takenKeys = useMemo(() => (rows ?? []).map((row) => row.key), [rows]);

  return (
    <>
      <AdminSectionHeader
        section="categories"
        actions={<CreateNewButton onClick={() => open(null)} />}
      />
      <AdminTable<CategoryAdminDto>
        label={tAdmin('sections.categories.title')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => localizedLabel(row, locale)}
        isArchived={(row) => !row.isActive}
        onRowClick={(row) => open(row.id)}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        empty={{ title: t('emptyTitle'), description: t('emptyDescription') }}
        reorder={{
          onReorder: (ids, expectedIds) => reorder.mutate({ ids, expectedIds }),
          disabled: reorder.isPending,
        }}
      />
      <WhoCanSeeNote audience="superAdmins">{t('whoCanSee')}</WhoCanSeeNote>
      {sheet && (sheet.id === null || editing) ? (
        <CategorySheet
          key={sheet.key}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          category={editing}
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
