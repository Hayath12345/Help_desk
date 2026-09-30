'use client';

import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  auditLogActorListSchema,
  auditLogListSchema,
  generalSettingsDtoSchema,
  type AuditLogEntryDto,
  type AuditLogList,
} from '@loons/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { adminGet, adminKeys, adminPath, type AdminListParams } from '@/lib/admin';
import { isolateDirection } from '@/lib/format';
import { AdminSectionHeader, AdminTable, WhoCanSeeNote, type AdminTableColumn } from '../../kit';
import type { AdminSectionProps } from '../types';
import { auditTimeZone, endOfDayExclusive, fieldChanges, startOfDay } from './audit-format';
import { EntrySheet, useActionName, useEntityName, useWhen } from './entry-sheet';

const ANY = 'any';

export interface AuditFilters {
  entity: string;
  action: string;
  actorId: string;
  /** YYYY-MM-DD (inclusive), '' for none. */
  from: string;
  /** YYYY-MM-DD (inclusive), '' for none. */
  to: string;
  /** One record's history ('' for every record). */
  entityId: string;
}

const NO_FILTERS: AuditFilters = {
  entity: '',
  action: '',
  actorId: '',
  from: '',
  to: '',
  entityId: '',
};

/**
 * The API query for `filters` (dates are whole days in `timeZone`: the business time zone, default
 * the app's display zone).
 */
export function auditQueryParams(filters: AuditFilters, timeZone?: string): AdminListParams {
  return {
    entity: filters.entity || undefined,
    action: filters.action || undefined,
    actorId: filters.actorId || undefined,
    entityId: filters.entityId || undefined,
    from: filters.from ? (startOfDay(filters.from, timeZone) ?? undefined) : undefined,
    to: filters.to ? (endOfDayExclusive(filters.to, timeZone) ?? undefined) : undefined,
  };
}

interface FilterSelectProps {
  label: string;
  anyLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}

function FilterSelect({ label, anyLabel, value, onValueChange, options }: FilterSelectProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={`${id}-label`} className="text-[13px] font-medium text-ink-secondary">
        {label}
      </span>
      <Select
        value={value || ANY}
        onValueChange={(next) => onValueChange(next === ANY ? '' : next)}
      >
        <SelectTrigger
          id={id}
          size="sm"
          aria-labelledby={`${id}-label ${id}`}
          className="w-full min-w-40 sm:w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80">
          <SelectItem value={ANY}>{anyLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Audit log (spec §10.11; E17): every admin change, newest first — who, when, the action, the
 * record and how many fields changed; filters by record type, action, person and date range, a
 * record's own history, "Load older entries" (cursor paging), and each entry's before / after in a
 * read-only sheet. Super admins only.
 */
export default function AuditLogSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-comms.auditLog');
  const entityName = useEntityName();
  const actionName = useActionName();
  // Days and times in the configured business time zone (E11): the same cache as the General
  // settings section, so a change there applies here too.
  const settings = useQuery({
    queryKey: adminKeys.list('settings'),
    queryFn: ({ signal }) => adminGet(adminPath('settings'), generalSettingsDtoSchema, { signal }),
    staleTime: 60_000,
  });
  const timeZone = auditTimeZone(settings.data?.values.businessTimezone);
  const when = useWhen(timeZone);
  const fromId = useId();
  const toId = useId();
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTERS);
  const [sheet, setSheet] = useState<{
    entry: AuditLogEntryDto;
    session: number;
    open: boolean;
  } | null>(null);
  const params = useMemo(() => auditQueryParams(filters, timeZone), [filters, timeZone]);
  const filtered = Object.values(filters).some((value) => value !== '');

  const log = useInfiniteQuery({
    queryKey: adminKeys.list('audit-log', params),
    queryFn: ({ pageParam, signal }) =>
      adminGet(adminPath('audit-log'), auditLogListSchema, {
        params: { ...params, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditLogList) => last.nextCursor ?? undefined,
    staleTime: 30_000,
    retry: false,
  });
  const rows = log.data?.pages.flatMap((page) => page.items);

  // Everyone who has entries, whatever their status or role now: a disabled or demoted admin's
  // changes must stay filterable.
  const actors = useQuery({
    queryKey: [...adminKeys.section('audit-log'), 'actors'],
    queryFn: ({ signal }) =>
      adminGet(adminPath('audit-log', 'actors'), auditLogActorListSchema, { signal }),
    staleTime: 60_000,
  });
  const actorOptions = (actors.data?.items ?? []).map((person) => ({
    value: person.id,
    label:
      person.status === 'DISABLED'
        ? t('filters.actorDisabled', { name: person.name })
        : person.name,
  }));

  const set = (patch: Partial<AuditFilters>) => setFilters((current) => ({ ...current, ...patch }));

  const columns: AdminTableColumn<AuditLogEntryDto>[] = [
    {
      id: 'when',
      header: t('columns.when'),
      width: 'minmax(0,1.2fr)',
      // The row's open button: its name also says what happened (the other cells are separate).
      cell: (row) => (
        <span className="whitespace-nowrap">
          {when(row.createdAt)}
          <span className="sr-only">
            {` · ${actionName(row.action)} · ${entityName(row.entity)}`}
            {row.entityLabel ? ` · ${row.entityLabel}` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'who',
      header: t('columns.who'),
      width: 'minmax(0,1.2fr)',
      cell: (row) =>
        row.actor ? (
          <span className="block truncate">{row.actor.name}</span>
        ) : (
          <span className="text-ink-muted">{t('unknownActor')}</span>
        ),
    },
    {
      id: 'action',
      header: t('columns.action'),
      width: '130px',
      cell: (row) => <Badge variant="secondary">{actionName(row.action)}</Badge>,
    },
    {
      id: 'record',
      header: t('columns.record'),
      width: 'minmax(0,2fr)',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] text-ink-muted">{entityName(row.entity)}</span>
          {row.entityLabel ? (
            <span dir="auto" className="truncate text-ink">
              {row.entityLabel}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'changes',
      header: t('columns.changes'),
      width: '110px',
      hideOnMobile: true,
      cell: (row) => {
        const count = fieldChanges(row).length;
        return count > 0 ? t('fieldsChanged', { count }) : t('noFieldsChanged');
      },
    },
  ];

  const toolbar = (
    <div role="group" aria-label={t('filters.label')} className="flex flex-wrap items-end gap-3">
      <FilterSelect
        label={t('filters.entity')}
        anyLabel={t('filters.anyEntity')}
        value={filters.entity}
        onValueChange={(entity) => set({ entity, entityId: '' })}
        options={AUDIT_ENTITIES.map((entity) => ({ value: entity, label: entityName(entity) }))}
      />
      <FilterSelect
        label={t('filters.action')}
        anyLabel={t('filters.anyAction')}
        value={filters.action}
        onValueChange={(action) => set({ action })}
        options={AUDIT_ACTIONS.map((action) => ({ value: action, label: actionName(action) }))}
      />
      <FilterSelect
        label={t('filters.actor')}
        anyLabel={t('filters.anyActor')}
        value={filters.actorId}
        onValueChange={(actorId) => set({ actorId })}
        options={actorOptions}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-[13px] font-medium text-ink-secondary">
          {t('filters.from')}
        </label>
        <Input
          id={fromId}
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(event) => set({ from: event.target.value })}
          className="h-8 w-40"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-[13px] font-medium text-ink-secondary">
          {t('filters.to')}
        </label>
        <Input
          id={toId}
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          aria-describedby={`${toId}-hint`}
          onChange={(event) => set({ to: event.target.value })}
          className="h-8 w-40"
        />
        <span id={`${toId}-hint`} className="sr-only">
          {t('filters.toHint')}
        </span>
      </div>
      <p className="basis-full text-[13px] text-ink-muted">{t('filters.timeZone', { timeZone })}</p>
      {filtered ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
          {t('filters.clear')}
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <AdminSectionHeader section="audit-log" />
      {filters.entityId ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="h-7 gap-1.5 px-2.5 text-[13px]">
            {/* Isolated left-to-right: an id starting with digits would reorder in Arabic. */}
            {t('filters.record', { id: isolateDirection(filters.entityId, 'ltr') })}
          </Badge>
          <Button type="button" variant="ghost" size="sm" onClick={() => set({ entityId: '' })}>
            <X aria-hidden="true" />
            {t('filters.removeRecord')}
          </Button>
        </div>
      ) : null}
      <AdminTable
        label={t('tableLabel')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${actionName(row.action)} ${entityName(row.entity)}`}
        onRowClick={(entry) =>
          setSheet((current) => ({ entry, session: (current?.session ?? 0) + 1, open: true }))
        }
        loading={log.isPending}
        error={log.isError && !log.data ? log.error : undefined}
        onRetry={() => void log.refetch()}
        toolbar={toolbar}
        empty={
          filtered
            ? { title: t('emptyFilteredTitle'), description: t('emptyFilteredDescription') }
            : { title: t('emptyTitle'), description: t('emptyDescription') }
        }
      />
      {log.hasNextPage ? (
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-disabled={log.isFetchingNextPage || undefined}
            onClick={() => {
              if (!log.isFetchingNextPage) void log.fetchNextPage();
            }}
          >
            {log.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
          </Button>
          {log.isFetchNextPageError ? (
            <p role="alert" className="text-[13px] text-danger">
              {t('loadMoreError')}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] leading-normal text-ink-muted">{t('readOnly')}</p>
        <WhoCanSeeNote audience="superAdmins" />
      </div>
      {sheet ? (
        <EntrySheet
          key={sheet.session}
          entry={sheet.entry}
          timeZone={timeZone}
          open={sheet.open}
          onOpenChange={(open) => setSheet((current) => (current ? { ...current, open } : current))}
          onShowRecord={(entry) => {
            setFilters({
              ...NO_FILTERS,
              entity: (AUDIT_ENTITIES as readonly string[]).includes(entry.entity)
                ? entry.entity
                : '',
              entityId: entry.entityId,
            });
            setSheet((current) => (current ? { ...current, open: false } : current));
          }}
        />
      ) : null}
    </>
  );
}
