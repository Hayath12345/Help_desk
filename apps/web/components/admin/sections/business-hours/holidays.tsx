'use client';

import { holidayListSchema, type HolidayAdminDto, type Locale } from '@loons/shared';
import { Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminGet, adminPath, useAdminList } from '@/lib/admin';
import { AdminTable, type AdminTableColumn } from '../../kit';
import { holidayDateLabel } from './format';
import { HolidaySheet } from './holiday-sheet';

type SheetState = { mode: 'create' } | { mode: 'edit'; id: string };
const ALL_YEARS = 'all';

/**
 * Public holidays (E12): a table per year with "Add holiday", archive / restore in the sheet.
 * Every holiday is fetched (archived included, they are few) so a date that is already taken can
 * be offered instead of added twice.
 */
export function Holidays() {
  const t = useTranslations('admin-sla.holidays');
  const locale = useLocale() as Locale;
  const id = useId();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<string>(String(thisYear));
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const list = useAdminList({
    section: 'business-hours',
    params: { view: 'holidays', status: 'all' },
    queryFn: (signal) =>
      adminGet(adminPath('business-hours', 'holidays'), holidayListSchema, {
        params: { status: 'all' },
        signal,
      }),
  });
  const all = useMemo(() => list.data?.items ?? [], [list.data]);
  const years = useMemo(() => {
    const set = new Set([thisYear, thisYear + 1, ...all.map((h) => Number(h.date.slice(0, 4)))]);
    return [...set].sort((a, b) => a - b);
  }, [all, thisYear]);
  const rows = list.data
    ? all.filter((h) => year === ALL_YEARS || h.date.startsWith(`${year}-`))
    : undefined;
  const current = sheet?.mode === 'edit' ? all.find((h) => h.id === sheet.id) : undefined;

  const columns: AdminTableColumn<HolidayAdminDto>[] = [
    {
      id: 'date',
      header: t('table.date'),
      width: 'minmax(0,1.2fr)',
      cell: (h) => <span className="tabular-nums">{holidayDateLabel(h.date, locale)}</span>,
    },
    {
      id: 'name',
      header: t('table.name'),
      width: 'minmax(0,1.5fr)',
      cell: (h) => (
        <span lang="en" dir="ltr" className="truncate">
          {h.name}
        </span>
      ),
    },
    {
      id: 'nameAr',
      header: t('table.nameAr'),
      width: 'minmax(0,1.5fr)',
      cell: (h) =>
        h.nameAr ? (
          <span lang="ar" dir="rtl" className="truncate">
            {h.nameAr}
          </span>
        ) : (
          <span className="text-ink-muted">{t('noArabic')}</span>
        ),
    },
  ];

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="text-lg font-semibold text-ink">
          {t('title')}
        </h2>
        <Button type="button" onClick={() => setSheet({ mode: 'create' })}>
          <Plus aria-hidden="true" />
          {t('add')}
        </Button>
      </div>
      <AdminTable
        label={t('title')}
        columns={columns}
        rows={rows}
        getRowId={(h) => h.id}
        getRowLabel={(h) => h.name}
        isArchived={(h) => !h.isActive}
        onRowClick={(h) => setSheet({ mode: 'edit', id: h.id })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showArchived}
        onShowArchivedChange={setShowArchived}
        empty={{
          title: year === ALL_YEARS ? t('empty') : t('emptyYear', { year }),
          description: t('emptyDescription'),
        }}
        toolbar={
          <div className="flex items-center gap-2">
            <label htmlFor={`${id}-year`} className="text-[13px] text-ink-secondary">
              {t('year')}
            </label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger id={`${id}-year`} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_YEARS}>{t('allYears')}</SelectItem>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {String(y)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <HolidaySheet
        open={sheet !== null && (sheet.mode === 'create' || current !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        mode={sheet?.mode ?? 'create'}
        holiday={current}
        all={all}
        onOpenHoliday={(holidayId) => {
          const target = all.find((h) => h.id === holidayId);
          if (target) setYear(target.date.slice(0, 4));
          setSheet({ mode: 'edit', id: holidayId });
        }}
        onReload={async () =>
          sheet?.mode === 'edit'
            ? (await list.refetch()).data?.items.find((h) => h.id === sheet.id)
            : undefined
        }
      />
    </section>
  );
}
