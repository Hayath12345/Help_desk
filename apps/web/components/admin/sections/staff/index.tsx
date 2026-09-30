'use client';

import { STAFF_ROLES, staffListSchema, type StaffAdminDto, type StaffRole } from '@loons/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminGet, adminKeys, adminPath } from '@/lib/admin';
import { teamName } from '@/lib/tickets/labels';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '../../kit';
import { PhoneStatus } from '../teams/people';
import type { AdminSectionProps } from '../types';
import { StaffSheet } from './staff-sheet';

type SheetState = { mode: 'create' } | { mode: 'edit'; id: string };
type RoleFilter = StaffRole | 'ALL';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

/** The search text after the user paused typing. */
function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Staff (E9; Super Admins only): staff accounts with their role, job title, phone and teams.
 * Accounts are created here; the person signs in with Microsoft and the account links on first
 * use. Disabled accounts are the "archived" rows.
 */
export default function StaffSection({ userId }: AdminSectionProps) {
  const t = useTranslations('admin-people.staff');
  const tCommon = useTranslations('admin-people.common');
  const tSections = useTranslations('admin.sections');
  const tPeople = useTranslations('admin-people');
  const locale = useLocale();
  const id = useId();
  const [showDisabled, setShowDisabled] = useState(false);
  const [role, setRole] = useState<RoleFilter>('ALL');
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), SEARCH_DELAY_MS);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const params = {
    status: showDisabled ? 'all' : 'active',
    role: role === 'ALL' ? undefined : role,
    search: term || undefined,
  };
  const list = useInfiniteQuery({
    queryKey: adminKeys.list('staff', params),
    queryFn: ({ pageParam, signal }) =>
      adminGet(adminPath('staff'), staffListSchema, {
        params: { ...params, limit: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const rows = list.data?.pages.flatMap((page) => page.items);
  const current = sheet?.mode === 'edit' ? rows?.find((s) => s.id === sheet.id) : undefined;

  const columns: AdminTableColumn<StaffAdminDto>[] = [
    {
      id: 'name',
      header: t('table.name'),
      width: 'minmax(0,2fr)',
      cell: (s) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{s.name}</span>
          <span dir="ltr" className="truncate text-start text-[13px] font-normal text-ink-muted">
            {s.email}
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: t('table.role'),
      cell: (s) => (
        <Badge variant={s.role === 'SUPER_ADMIN' ? 'default' : 'secondary'}>
          {tCommon(`roles.${s.role}`)}
        </Badge>
      ),
    },
    {
      id: 'jobTitle',
      header: t('table.jobTitle'),
      hideOnMobile: true,
      cell: (s) => <span className="truncate">{s.jobTitle ?? ''}</span>,
    },
    {
      id: 'phone',
      header: t('table.phone'),
      cell: (s) => <PhoneStatus hasPhone={s.phone !== null} phoneValid={s.phoneValid} />,
    },
    {
      id: 'teams',
      header: t('table.teams'),
      hideOnMobile: true,
      cell: (s) => (
        <span className="truncate">
          {s.teams
            .filter((team) => team.isActive)
            .map((team) => teamName(team, locale))
            .join(', ')}
        </span>
      ),
    },
    {
      id: 'signIn',
      header: t('table.status'),
      hideOnMobile: true,
      cell: (s) => (
        <span className={s.microsoftLinked ? undefined : 'text-ink-muted'}>
          {s.microsoftLinked ? t('linked') : t('notLinked')}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader
        section="staff"
        actions={<CreateNewButton onClick={() => setSheet({ mode: 'create' })} />}
      />
      <AdminTable
        label={tSections('staff.title')}
        columns={columns}
        rows={rows}
        getRowId={(s) => s.id}
        getRowLabel={(s) => s.name}
        isArchived={(s) => s.status !== 'ACTIVE'}
        onRowClick={(s) => setSheet({ mode: 'edit', id: s.id })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        showArchived={showDisabled}
        onShowArchivedChange={setShowDisabled}
        empty={{ title: t('empty'), description: '' }}
        toolbar={
          <>
            <div className="relative">
              <label htmlFor={`${id}-search`} className="sr-only">
                {tCommon('search')}
              </label>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
              />
              <Input
                id={`${id}-search`}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tCommon('search')}
                className="w-64 max-w-full ps-9"
              />
            </div>
            <SegmentedControl
              aria-label={t('roleFilter')}
              size="sm"
              value={role}
              onValueChange={setRole}
              options={[
                { value: 'ALL', label: t('allRoles') },
                ...STAFF_ROLES.map((r) => ({ value: r, label: tCommon(`roles.${r}`) })),
              ]}
            />
          </>
        }
      />
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          aria-busy={list.isFetchingNextPage || undefined}
          onClick={() => {
            if (!list.isFetchingNextPage) void list.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage ? tCommon('loadingMore') : tCommon('loadMore')}
        </Button>
      ) : null}
      <WhoCanSeeNote>{tPeople('whoCanSee.staff')}</WhoCanSeeNote>
      <StaffSheet
        open={sheet !== null && (sheet.mode === 'create' || current !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        mode={sheet?.mode ?? 'create'}
        staff={current}
        viewerId={userId}
        onReload={async () =>
          sheet?.mode === 'edit'
            ? (await list.refetch()).data?.pages
                .flatMap((page) => page.items)
                .find((s) => s.id === sheet.id)
            : undefined
        }
      />
    </div>
  );
}
