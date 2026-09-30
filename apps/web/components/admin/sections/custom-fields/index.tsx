'use client';

import { hasOptions, type CustomFieldAdminDto, type Locale } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '@/components/admin/kit';
import { localizedLabel } from '@/lib/tickets/labels';
import { useCategoryList } from '../categories/data';
import type { AdminSectionProps } from '../types';
import { useCustomFieldList } from './data';
import { FieldSheet } from './field-sheet';

type SheetState = { key: number; id: string | null } | null;

/**
 * Custom fields (spec §10.2; E1, E4, E5, E6): the plain table with "Create new" and the edit
 * sheet. Fields have no global order: their position is set per category (category sheet).
 * Super admins only.
 */
export default function CustomFieldsSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-setup.customFields');
  const tTypes = useTranslations('admin-setup.fieldTypes');
  const tAdmin = useTranslations('admin');
  const locale = useLocale() as Locale;
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useCustomFieldList();
  const categories = useCategoryList();
  const rows = list.data?.items;

  const open = (id: string | null) => {
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, id }));
    setSheetOpen(true);
  };

  const columns = useMemo<AdminTableColumn<CustomFieldAdminDto>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        width: 'minmax(0,2fr)',
        cell: (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{localizedLabel(row, locale)}</span>
            <span dir="ltr" className="w-fit truncate font-mono text-xs font-normal text-ink-muted">
              {row.key}
            </span>
          </span>
        ),
      },
      { id: 'type', header: t('columns.type'), cell: (row) => tTypes(row.type) },
      {
        id: 'options',
        header: t('columns.options'),
        width: '120px',
        hideOnMobile: true,
        cell: (row) =>
          hasOptions(row.type)
            ? t('optionCount', { count: row.options.filter((o) => o.isActive).length })
            : '—',
      },
      {
        id: 'required',
        header: t('columns.required'),
        width: '100px',
        cell: (row) => (row.required ? t('requiredYes') : t('requiredNo')),
      },
      {
        id: 'categories',
        header: t('columns.categories'),
        width: 'minmax(0,2fr)',
        cell: (row) => (
          <span className="truncate">
            {row.categories.length
              ? row.categories.map((c) => localizedLabel(c, locale)).join(', ')
              : t('noLinks')}
          </span>
        ),
      },
    ],
    [t, tTypes, locale],
  );

  const editing = sheet?.id ? rows?.find((row) => row.id === sheet.id) : undefined;
  const takenKeys = useMemo(() => (rows ?? []).map((row) => row.key), [rows]);

  return (
    <>
      <AdminSectionHeader
        section="custom-fields"
        actions={<CreateNewButton onClick={() => open(null)} />}
      />
      <AdminTable<CustomFieldAdminDto>
        label={tAdmin('sections.custom-fields.title')}
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
      />
      <WhoCanSeeNote audience="superAdmins">{t('whoCanSee')}</WhoCanSeeNote>
      {sheet && (sheet.id === null || editing) ? (
        <FieldSheet
          key={sheet.key}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          field={editing}
          takenKeys={takenKeys}
          categories={categories.data?.items ?? []}
          reload={async () => {
            const fresh = await list.refetch();
            return fresh.data?.items.find((row) => row.id === sheet.id);
          }}
        />
      ) : null}
    </>
  );
}
