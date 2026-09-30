'use client';

import {
  organizationListSchema,
  pendingSignupListSchema,
  pendingSignupResponseSchema,
  type PendingSignupDto,
} from '@loons/shared';
import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Combobox } from '@/components/tickets/combobox';
import { FormField } from '@/components/tickets/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  adminGet,
  adminKeys,
  adminPath,
  adminWrite,
  useAdminMutation,
  withExpectedUpdatedAt,
} from '@/lib/admin';
import { formatDate } from '@/lib/format';
import { placeName } from '@/lib/tickets/labels';
import { AdminSheet, AdminTable, ConfirmDialog, type AdminTableColumn } from '../../kit';
import { usePeopleErrorText } from '../teams/people';

type PendingPages = InfiniteData<{ items: PendingSignupDto[]; nextCursor: string | null }>;

export interface PendingSignupsProps {
  list: UseInfiniteQueryResult<PendingPages>;
}

/**
 * Pending sign-ups (E10): clients whose address matched no organisation. Opening one lets the
 * admin approve it into an active organisation or reject it (the account is disabled). Rejected
 * sign-ups can be shown too: approving one is the way back from a reject.
 */
export function PendingSignups({ list }: PendingSignupsProps) {
  const t = useTranslations('admin-people.clients.pending');
  const tTabs = useTranslations('admin-people.clients.tabs');
  const tCommon = useTranslations('admin-people.common');
  const locale = useLocale();
  const id = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const rejected = useInfiniteQuery({
    queryKey: adminKeys.list('clients', { pending: true, status: 'rejected' }),
    queryFn: pendingListFetcher({ status: 'rejected' }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: showRejected,
    staleTime: 30_000,
  });
  const waiting = list.data?.pages.flatMap((page) => page.items);
  const waitingIds = new Set(waiting?.map((row) => row.id));
  const rejectedRows = showRejected
    ? (rejected.data?.pages.flatMap((page) => page.items) ?? []).filter(
        (row) => !waitingIds.has(row.id),
      )
    : [];
  const rows = waiting ? [...waiting, ...rejectedRows] : undefined;
  const current = rows?.find((row) => row.id === openId);

  const columns: AdminTableColumn<PendingSignupDto>[] = [
    {
      id: 'name',
      header: t('table.name'),
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{row.name}</span>
          {row.status === 'DISABLED' ? (
            <Badge variant="destructive">{t('rejectedBadge')}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      id: 'email',
      header: t('table.email'),
      width: 'minmax(0,1.5fr)',
      cell: (row) => (
        <span dir="ltr" className="truncate">
          {row.email}
        </span>
      ),
    },
    {
      id: 'company',
      header: t('table.company'),
      hideOnMobile: true,
      cell: (row) => <span className="truncate">{row.signupCompany ?? ''}</span>,
    },
    {
      id: 'date',
      header: t('table.date'),
      hideOnMobile: true,
      cell: (row) => formatDate(row.createdAt, locale),
    },
    {
      id: 'verified',
      header: t('table.verified'),
      cell: (row) =>
        row.emailVerified ? (
          <Badge variant="success">{t('verified')}</Badge>
        ) : (
          <Badge variant="secondary">{t('unverified')}</Badge>
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-ink-secondary">{t('intro')}</p>
      <AdminTable
        label={tTabs('pending')}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        onRowClick={(row) => setOpenId(row.id)}
        loading={list.isPending}
        error={list.error ?? (showRejected ? rejected.error : null)}
        onRetry={() => {
          void list.refetch();
          if (showRejected) void rejected.refetch();
        }}
        empty={{ title: t('empty'), description: '' }}
        toolbar={
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-rejected`}
              checked={showRejected}
              onCheckedChange={(checked) => setShowRejected(checked)}
            />
            <label
              htmlFor={`${id}-rejected`}
              className="cursor-pointer text-[13px] text-ink-secondary"
            >
              {t('showRejected')}
            </label>
          </div>
        }
      />
      {list.hasNextPage || (showRejected && rejected.hasNextPage) ? (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          onClick={() => {
            // The waiting sign-ups first, then the rejected ones.
            const next = list.hasNextPage ? list : rejected;
            if (!next.isFetchingNextPage) void next.fetchNextPage();
          }}
        >
          {list.isFetchingNextPage || rejected.isFetchingNextPage
            ? tCommon('loadingMore')
            : tCommon('loadMore')}
        </Button>
      ) : null}
      <ReviewSheet
        signup={current}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        onReload={() => Promise.all([list.refetch(), showRejected ? rejected.refetch() : null])}
      />
    </div>
  );
}

function ReviewSheet({
  signup,
  onOpenChange,
  onReload,
}: {
  signup: PendingSignupDto | undefined;
  onOpenChange: (open: boolean) => void;
  onReload: () => Promise<unknown>;
}) {
  const t = useTranslations('admin-people.clients.pending');
  const tKit = useTranslations('admin.kit');
  const locale = useLocale();
  const errorText = usePeopleErrorText();
  const id = useId();
  // The organisation picked, with its label: the picker searches on the server, so after a search
  // the chosen one may not be among the options shown once it closes.
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const orgId = picked?.id ?? '';
  const [search, setSearch] = useState('');
  const [confirmReject, setConfirmReject] = useState(false);
  const open = signup !== undefined;
  const isRejected = signup?.status === 'DISABLED';

  const orgParams = { status: 'active', search: search.trim() || undefined, limit: 20 };
  const orgs = useQuery({
    queryKey: adminKeys.list('clients', { ...orgParams, picker: true }),
    queryFn: ({ signal }) =>
      adminGet(adminPath('clients'), organizationListSchema, { params: orgParams, signal }),
    enabled: open,
    staleTime: 30_000,
  });
  const options = (orgs.data?.items ?? []).map((org) => ({
    value: org.id,
    label: placeName(org, locale),
    description: org.emailDomains.join(', ') || undefined,
  }));

  const decide = useAdminMutation({
    section: 'clients',
    scopes: ['form-context'],
    errorToast: false,
    mutationFn: (vars: { action: 'approve' | 'reject'; orgId?: string }) =>
      adminWrite(
        'POST',
        adminPath('clients', 'pending-signups', signup!.id, vars.action),
        withExpectedUpdatedAt(vars.orgId ? { orgId: vars.orgId } : {}, signup!),
        pendingSignupResponseSchema,
      ),
    success: (result, vars) =>
      t(vars.action === 'approve' ? 'approved' : 'rejected', { name: result.item.name }),
    onSuccess: () => {
      setPicked(null);
      onOpenChange(false);
    },
  });

  return (
    <AdminSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          decide.reset();
          setPicked(null);
        }
        onOpenChange(next);
      }}
      title={t('reviewTitle', { name: signup?.name ?? '' })}
      mode="edit"
      conflict={decide.isConflict}
      onReload={async () => {
        await onReload();
        decide.reset();
      }}
      error={decide.error && !decide.isConflict ? errorText(decide.error) : undefined}
    >
      {signup ? (
        <div className="flex flex-col gap-[18px]">
          <dl className="flex flex-col gap-1 text-ink-secondary">
            <dt className="sr-only">{t('table.email')}</dt>
            <dd dir="ltr" className="text-start font-medium text-ink">
              {signup.email}
            </dd>
            <dt className="sr-only">{t('table.company')}</dt>
            <dd>
              {signup.signupCompany
                ? t('company', { company: signup.signupCompany })
                : t('noCompany')}
            </dd>
            <dt className="sr-only">{t('table.date')}</dt>
            <dd>{formatDate(signup.createdAt, locale)}</dd>
          </dl>
          {isRejected ? (
            <Alert variant="warning" role="note" className="px-3.5 py-3">
              <AlertDescription>{t('rejectedNote')}</AlertDescription>
            </Alert>
          ) : null}
          {!signup.emailVerified ? (
            <Alert variant="warning" role="note" className="px-3.5 py-3">
              <AlertDescription>{t('unverifiedNote')}</AlertDescription>
            </Alert>
          ) : null}
          <FormField id={`${id}-org`} labelKind="group" label={t('organisation')}>
            <Combobox
              id={`${id}-org`}
              aria-labelledby={`${id}-org-label`}
              value={orgId}
              onValueChange={(value) => {
                const option = options.find((o) => o.value === value);
                setPicked(value ? { id: value, label: option?.label ?? '' } : null);
              }}
              selectedLabel={picked?.label}
              options={options}
              onSearchChange={setSearch}
              loading={orgs.isFetching}
              placeholder={t('chooseOrg')}
              searchPlaceholder={t('searchOrg')}
              emptyText={t('noOrg')}
            />
          </FormField>
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            {/* A rejected sign-up can only be approved: that is the way back from the reject. */}
            {isRejected ? null : (
              <Button
                type="button"
                variant="destructive"
                aria-disabled={decide.isPending || undefined}
                onClick={() => {
                  if (!decide.isPending) setConfirmReject(true);
                }}
              >
                {t('reject')}
              </Button>
            )}
            <Button
              type="button"
              className="ms-auto"
              aria-disabled={!orgId || decide.isPending || undefined}
              aria-busy={(decide.isPending && decide.variables?.action === 'approve') || undefined}
              onClick={() => {
                if (!orgId || decide.isPending) return;
                decide.mutate({ action: 'approve', orgId });
              }}
            >
              {decide.isPending && decide.variables?.action === 'approve'
                ? t('approving')
                : t('approve')}
            </Button>
          </div>
          <ConfirmDialog
            open={confirmReject}
            onOpenChange={setConfirmReject}
            title={t('rejectTitle', { name: signup.name })}
            description={t('rejectBody')}
            confirmLabel={t('reject')}
            cancelLabel={tKit('cancel')}
            destructive
            busy={decide.isPending}
            onConfirm={() => {
              setConfirmReject(false);
              decide.mutate({ action: 'reject' });
            }}
          />
        </div>
      ) : null}
    </AdminSheet>
  );
}

/** The pending list's query (shared with the tab's count). */
export const PENDING_PAGE_SIZE = 100;
export const pendingListFetcher =
  (params: Record<string, string | undefined>) =>
  ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
    adminGet(adminPath('clients', 'pending-signups'), pendingSignupListSchema, {
      params: { ...params, limit: PENDING_PAGE_SIZE, cursor: pageParam },
      signal,
    });
