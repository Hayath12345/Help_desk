'use client';

import type { SkillAdminDto } from '@loons/shared';
import { Info } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '@/components/admin/kit';
import { cn } from '@/lib/utils';
import type { AdminSectionProps } from '../types';
import { useSkillList } from './data';
import { SkillSheet } from './skill-sheet';

type SheetState = { key: number; id: string | null } | null;

const LINK_CLASS =
  'rounded-sm text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-hidden';

/** How many staff / categories use a skill: a muted 0 says "nothing uses it yet". */
function Count({ value }: { value: number }) {
  return <span className={cn('tabular-nums', value === 0 && 'text-ink-muted')}>{value}</span>;
}

/**
 * Skills (docs/AUTO_ASSIGN.md; Super Admins only): the catalog of things staff can be good at
 * ("Network", "CCTV"). Staff get their skills under Staff and categories list the skills they
 * need under Categories & sub-types; a new ticket goes to the best-matching team member. Skills
 * are archived, never deleted: an archived skill keeps its links but stops counting for matching.
 */
export default function SkillsSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-people.skills');
  const tAdmin = useTranslations('admin');
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useSkillList();
  const rows = list.data?.items;

  const open = (id: string | null) => {
    setSheet((current) => ({ key: (current?.key ?? 0) + 1, id }));
    setSheetOpen(true);
  };

  const columns = useMemo<AdminTableColumn<SkillAdminDto>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        width: 'minmax(0,2fr)',
        cell: (row) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate">
              <bdi lang="en">{row.labelEn}</bdi>
            </span>
            <span dir="ltr" className="w-fit truncate font-mono text-xs font-normal text-ink-muted">
              {row.key}
            </span>
          </span>
        ),
      },
      {
        id: 'nameAr',
        header: t('columns.nameAr'),
        width: 'minmax(0,1.5fr)',
        cell: (row) =>
          row.labelAr.trim() ? (
            <span className="truncate">
              <bdi lang="ar" dir="rtl">
                {row.labelAr}
              </bdi>
            </span>
          ) : (
            <span className="truncate text-ink-muted">{t('noArabic')}</span>
          ),
      },
      {
        id: 'staff',
        header: t('columns.staff'),
        width: '110px',
        cell: (row) => <Count value={row.staffCount} />,
      },
      {
        id: 'categories',
        header: t('columns.categories'),
        width: '110px',
        cell: (row) => <Count value={row.categoryCount} />,
      },
    ],
    [t],
  );

  const editing = sheet?.id ? rows?.find((row) => row.id === sheet.id) : undefined;

  return (
    <>
      <AdminSectionHeader
        section="skills"
        actions={<CreateNewButton label={t('newSkill')} onClick={() => open(null)} />}
      />
      <p
        role="note"
        className="flex items-start gap-2 text-[13px] leading-normal text-ink-secondary"
      >
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {t.rich('hint', {
            categories: (chunks) => (
              <Link href="/admin/categories" className={LINK_CLASS}>
                {chunks}
              </Link>
            ),
            staff: (chunks) => (
              <Link href="/admin/staff" className={LINK_CLASS}>
                {chunks}
              </Link>
            ),
          })}
        </span>
      </p>
      <AdminTable<SkillAdminDto>
        label={tAdmin('sections.skills.title')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.labelEn}
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
        <SkillSheet
          key={sheet.key}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          skill={editing}
          skills={rows ?? []}
          reload={async () => {
            const fresh = await list.refetch();
            return fresh.data?.items.find((row) => row.id === sheet.id);
          }}
        />
      ) : null}
    </>
  );
}
