'use client';

import { helpArticleListSchema, type HelpArticleAdminDto } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  adminConflictDetails,
  adminListFetcher,
  adminPath,
  adminWrite,
  reorderById,
  useAdminList,
  useAdminMutation,
} from '@/lib/admin';
import { formatDate } from '@/lib/format';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '../../kit';
import type { AdminSectionProps } from '../types';
import { ArticleSheet } from './article-sheet';

const LIST_PARAMS = { status: 'all' } as const;
const fetchArticles = adminListFetcher('help-center', helpArticleListSchema, {
  params: LIST_PARAMS,
});

type ArticleList = { items: HelpArticleAdminDto[] };

interface SheetState {
  /** null: creating. */
  id: string | null;
  session: number;
  open: boolean;
}

/**
 * Help center (spec §10.10; E15): FAQ articles in English and Arabic — a plain table in their
 * portal order (drag or Move up / Move down), drafts and published ones, archived ones behind
 * "Show archived", and the article sheet with its live preview. Super admins only.
 */
export default function HelpCenterSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-comms.helpCenter');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale() as 'en' | 'ar';
  const list = useAdminList({
    section: 'help-center',
    params: LIST_PARAMS,
    queryFn: fetchArticles,
  });
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const rows = list.data?.items;
  const takenKeys = useMemo(() => (rows ?? []).map((row) => row.key), [rows]);
  const sheetArticle = sheet?.id ? (rows?.find((row) => row.id === sheet.id) ?? null) : null;

  const reorder = useAdminMutation<
    { ids: string[]; expectedIds: string[] },
    undefined,
    ArticleList
  >({
    section: 'help-center',
    mutationFn: (body) => adminWrite('POST', adminPath('help-center', 'reorder'), body),
    optimistic: (cached, { ids }) => ({
      ...cached,
      items: reorderById(cached.items, ids, (item) => item.id),
    }),
    scopes: ['help-center'],
    success: tKit('toast.reordered'),
    errorToast: (error) => adminConflictDetails(error)?.reason !== 'order_changed',
    onError: (error) => {
      if (adminConflictDetails(error)?.reason === 'order_changed') toast.error(t('orderChanged'));
    },
  });

  const titleOf = (row: HelpArticleAdminDto) =>
    locale === 'ar' && row.titleAr.trim() !== '' ? row.titleAr : row.titleEn;

  const columns: AdminTableColumn<HelpArticleAdminDto>[] = [
    {
      id: 'title',
      header: t('columns.title'),
      width: 'minmax(0,3fr)',
      cell: (row) => (
        <span dir="auto" className="line-clamp-2 break-words">
          {titleOf(row)}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('columns.status'),
      width: '110px',
      cell: (row) =>
        row.isPublished ? (
          <Badge variant="success">{t('status.published')}</Badge>
        ) : (
          <Badge variant="secondary">{t('status.draft')}</Badge>
        ),
    },
    {
      id: 'key',
      header: t('columns.key'),
      width: 'minmax(0,1.4fr)',
      hideOnMobile: true,
      cell: (row) => (
        <span dir="ltr" className="block truncate font-mono text-[13px]">
          {row.key}
        </span>
      ),
    },
    {
      id: 'updated',
      header: t('columns.updated'),
      width: '120px',
      hideOnMobile: true,
      cell: (row) => formatDate(row.updatedAt, locale),
    },
  ];

  const openSheet = (id: string | null) =>
    setSheet((current) => ({ id, session: (current?.session ?? 0) + 1, open: true }));

  return (
    <>
      <AdminSectionHeader
        section="help-center"
        actions={<CreateNewButton onClick={() => openSheet(null)} />}
      />
      <AdminTable
        label={t('tableLabel')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={titleOf}
        isArchived={(row) => !row.isActive}
        onRowClick={(row) => openSheet(row.id)}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        reorder={{
          onReorder: (ids, expectedIds) => reorder.mutate({ ids, expectedIds }),
          disabled: reorder.isPending,
        }}
        empty={{
          title: t('emptyTitle'),
          description: t('emptyDescription'),
        }}
      />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] leading-normal text-ink-muted">{t('portalNote')}</p>
        <WhoCanSeeNote audience="superAdmins" />
      </div>
      {sheet && (sheet.id === null || sheetArticle) ? (
        <ArticleSheet
          key={`${sheet.id ?? 'new'}:${sheet.session}`}
          article={sheetArticle}
          takenKeys={takenKeys}
          open={sheet.open}
          onOpenChange={(open) => setSheet((current) => (current ? { ...current, open } : current))}
        />
      ) : null}
    </>
  );
}
