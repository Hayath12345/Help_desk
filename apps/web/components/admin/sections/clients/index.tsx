'use client';

import { organizationListSchema, type OrganizationAdminDto } from '@loons/shared';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { adminGet, adminKeys, adminPath } from '@/lib/admin';
import { formatDate } from '@/lib/format';
import { placeName } from '@/lib/tickets/labels';
import {
  AdminSectionHeader,
  AdminTable,
  CreateNewButton,
  WhoCanSeeNote,
  type AdminTableColumn,
} from '../../kit';
import type { AdminSectionProps } from '../types';
import { OrgSheet } from './org-sheet';
import { PendingSignups, pendingListFetcher } from './pending-signups';

type SheetState =
  { mode: 'create' } | { mode: 'edit'; id: string; fallback?: OrganizationAdminDto };
type Tab = 'organisations' | 'pending';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Today in the display calendar, as YYYY-MM-DD (for the AMC-expired check). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Clients & sites (spec §10.7; E10; Super Admins only): client organisations with their contract,
 * AMC expiry, account manager, email domains and sites, and the pending sign-ups to approve or
 * reject.
 */
export default function ClientsSection(_props: AdminSectionProps) {
  const t = useTranslations('admin-people.clients');
  const tCommon = useTranslations('admin-people.common');
  const tSections = useTranslations('admin.sections');
  const tPeople = useTranslations('admin-people');
  const locale = useLocale();
  const id = useId();
  const [tab, setTab] = useState<Tab>('organisations');
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), SEARCH_DELAY_MS);
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const params = { status: showArchived ? 'all' : 'active', search: term || undefined };
  const list = useInfiniteQuery({
    queryKey: adminKeys.list('clients', params),
    queryFn: ({ pageParam, signal }) =>
      adminGet(adminPath('clients'), organizationListSchema, {
        params: { ...params, limit: PAGE_SIZE, cursor: pageParam },
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const pendingParams = {};
  const pending = useInfiniteQuery({
    queryKey: adminKeys.list('clients', { pending: true }),
    queryFn: pendingListFetcher(pendingParams),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const pendingCount = pending.data?.pages.reduce((n, page) => n + page.items.length, 0) ?? 0;

  const rows = list.data?.pages.flatMap((page) => page.items);
  const current =
    sheet?.mode === 'edit' ? (rows?.find((o) => o.id === sheet.id) ?? sheet.fallback) : undefined;

  const columns: AdminTableColumn<OrganizationAdminDto>[] = [
    {
      id: 'name',
      header: t('table.name'),
      width: 'minmax(0,2fr)',
      cell: (org) => placeName(org, locale),
    },
    {
      id: 'contract',
      header: t('table.contract'),
      width: 'minmax(0,1.5fr)',
      cell: (org) => (
        <span className="flex min-w-0 flex-col">
          <span>{t(`contract.${org.contractType}`)}</span>
          {org.amcExpiry ? (
            <span
              className={
                org.amcExpiry < today() ? 'text-[13px] text-danger' : 'text-[13px] text-ink-muted'
              }
            >
              {t(org.amcExpiry < today() ? 'contract.amcExpired' : 'contract.amcUntil', {
                date: formatDate(`${org.amcExpiry}T12:00:00Z`, locale),
              })}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'domains',
      header: t('table.domains'),
      hideOnMobile: true,
      width: 'minmax(0,1.5fr)',
      cell: (org) => (
        <span dir="ltr" className="truncate">
          {org.emailDomains.join(', ')}
        </span>
      ),
    },
    {
      id: 'sites',
      header: t('table.sites'),
      hideOnMobile: true,
      cell: (org) => t('table.siteCount', { count: org.sites.filter((s) => s.isActive).length }),
    },
    {
      id: 'clients',
      header: t('table.clients'),
      cell: (org) => t('table.clientCount', { count: org.clientCount }),
    },
    {
      id: 'manager',
      header: t('table.manager'),
      hideOnMobile: true,
      cell: (org) =>
        org.accountManager ? (
          <span className="truncate">{org.accountManager.name}</span>
        ) : (
          <span className="text-ink-muted">{tCommon('none')}</span>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      <AdminSectionHeader
        section="clients"
        actions={
          tab === 'organisations' ? (
            <CreateNewButton onClick={() => setSheet({ mode: 'create' })} />
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
        <TabsList variant="line" aria-label={t('tabs.label')}>
          <TabsTrigger value="organisations">{t('tabs.organisations')}</TabsTrigger>
          <TabsTrigger value="pending">
            {t('tabs.pendingCount', { count: pendingCount })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="organisations" className="flex flex-col gap-3">
          <AdminTable
            label={tSections('clients.title')}
            columns={columns}
            rows={rows}
            getRowId={(org) => org.id}
            getRowLabel={(org) => placeName(org, locale)}
            isArchived={(org) => !org.isActive}
            onRowClick={(org) => setSheet({ mode: 'edit', id: org.id })}
            loading={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
            showArchived={showArchived}
            onShowArchivedChange={setShowArchived}
            empty={{ title: t('empty'), description: '' }}
            toolbar={
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
            }
          />
          {list.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              className="self-center"
              onClick={() => {
                if (!list.isFetchingNextPage) void list.fetchNextPage();
              }}
            >
              {list.isFetchingNextPage ? tCommon('loadingMore') : tCommon('loadMore')}
            </Button>
          ) : null}
        </TabsContent>
        <TabsContent value="pending">
          <PendingSignups list={pending} />
        </TabsContent>
      </Tabs>
      <WhoCanSeeNote>{tPeople('whoCanSee.clients')}</WhoCanSeeNote>
      <OrgSheet
        open={sheet !== null && (sheet.mode === 'create' || current !== undefined)}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        mode={sheet?.mode ?? 'create'}
        org={current}
        onCreated={(org) => setSheet({ mode: 'edit', id: org.id, fallback: org })}
        onReload={async () =>
          sheet?.mode === 'edit'
            ? (await list.refetch()).data?.pages
                .flatMap((page) => page.items)
                .find((o) => o.id === sheet.id)
            : undefined
        }
      />
    </div>
  );
}
