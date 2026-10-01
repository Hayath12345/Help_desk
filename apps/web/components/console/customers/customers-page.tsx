'use client';

import { Search } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomers } from '@/lib/customers/queries';
import { formatNumber, isolate } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CUSTOMER_SEARCH_MAX,
  replaceCustomerSearch,
  useCustomerSearchParam,
} from './customers-url';
import { CustomerRowSkeleton, CustomerTableRow, CustomersTableHeader } from './customers-table';

/** Typing pause before the URL (and so the list query) follows the search box. */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;
const SKELETON_ROWS = 6;

/** "4 requesters across 4 companies" (ICU plurals; Latin digits in Arabic too). */
export function CustomersSummary({
  requesters,
  companies,
}: {
  requesters: number;
  companies: number;
}) {
  const t = useTranslations('console.customers');
  const locale = useLocale();
  if (requesters === 0) return <>{t('summaryNone')}</>;
  return (
    <>
      {t('summary', {
        requesters,
        companies,
        r: formatNumber(requesters, locale),
        c: formatNumber(companies, locale),
      })}
    </>
  );
}

/**
 * The search box (F8, beyond the design): requester name, email or company. The URL follows it
 * after a typing pause (Enter applies at once, Escape clears); Back / Forward and links update it.
 */
function CustomerSearch({ urlSearch }: { urlSearch: string }) {
  const t = useTranslations('console.customers');
  const [text, setText] = useState(urlSearch);
  const [synced, setSynced] = useState(urlSearch);
  if (synced !== urlSearch) {
    setSynced(urlSearch);
    if (text.trim() !== urlSearch) setText(urlSearch);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const apply = (value: string) => {
    cancel();
    replaceCustomerSearch(value);
  };

  return (
    // Named: the top bar has a search landmark too (the tickets search).
    <div role="search" aria-label={t('searchLabel')} className="relative w-full max-w-[420px]">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
      />
      <Input
        type="search"
        value={text}
        maxLength={CUSTOMER_SEARCH_MAX}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          cancel();
          timer.current = setTimeout(() => {
            timer.current = null;
            replaceCustomerSearch(value);
          }, CUSTOMER_SEARCH_DEBOUNCE_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply(text);
          } else if (event.key === 'Escape' && text) {
            event.preventDefault();
            setText('');
            apply('');
          }
        }}
        aria-label={t('searchLabel')}
        placeholder={t('searchPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        className="bg-surface ps-9"
      />
    </div>
  );
}

/**
 * Console Customers (design 965–985, Phase 5 F8): one row per active client requester with the
 * company, contract pill and open / total ticket counts over the tickets the viewer can see. The
 * header counts the whole search ("N requesters across M companies"); a search box and "Load more"
 * paging go beyond the design for large client bases. A row opens the Inbox company view (F9).
 * Live: refetched on `queue:updated`, after a reconnect and on `config:updated` `form-context`
 * (lib/realtime).
 */
export function Customers() {
  const t = useTranslations('console.customers');
  const search = useCustomerSearchParam();
  const list = useCustomers(search);
  const data = list.data;
  const rows = data?.items;
  const failed = list.isError && !rows;
  const stale = list.isPlaceholderData;
  const table = useRef<HTMLDivElement>(null);
  // "Load more" pressed with the focus on it: the focus continues on the first new row (the
  // button stays in place while the page loads, so the focus is never dropped).
  const focusFrom = useRef<number | null>(null);
  const rowCount = rows?.length ?? 0;
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || rowCount <= from) return;
    focusFrom.current = null;
    table.current?.querySelectorAll<HTMLElement>('[data-row-open]')[from]?.focus();
  }, [rowCount]);

  let body: React.ReactNode;
  if (list.isPending) {
    body = (
      <LoadingRegion label={t('loading')} role="rowgroup">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <CustomerRowSkeleton key={i} index={i} />
        ))}
      </LoadingRegion>
    );
  } else if (failed) {
    body = (
      <div role="rowgroup">
        <div role="row">
          <div role="cell">
            <div role="alert">
              <EmptyState
                headingLevel="p"
                title={t('loadFailed')}
                action={
                  <Button type="button" variant="outline" onClick={() => void list.refetch()}>
                    {t('retry')}
                  </Button>
                }
              />
            </div>
          </div>
        </div>
      </div>
    );
  } else if (!rows?.length) {
    body = (
      <div role="rowgroup">
        <div role="row">
          <div role="cell">
            <div role="status">
              {search ? (
                <EmptyState
                  headingLevel="p"
                  title={t('noMatch', { query: isolate(search) })}
                  description={t('noMatchHint')}
                />
              ) : (
                <EmptyState
                  headingLevel="p"
                  title={t('emptyTitle')}
                  description={t('emptyDescription')}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div
          role="rowgroup"
          className={cn('transition-opacity duration-150 ease-out', stale && 'opacity-60')}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row) => (
              <CustomerTableRow key={row.id} row={row} />
            ))}
          </AnimatePresence>
        </div>
        {list.isFetchingNextPage ? (
          // "Load more" says "Loading more customers…" (and keeps the focus).
          <div aria-hidden="true">
            <CustomerRowSkeleton index={rows.length} />
            <CustomerRowSkeleton index={rows.length + 1} />
          </div>
        ) : null}
      </>
    );
  }

  // Rendered inside the page's ConsolePage (22 px gap between the header, search and table).
  return (
    <>
      <PageHeader
        title={t('title')}
        description={
          data ? (
            <span aria-live="polite">
              <CustomersSummary
                requesters={data.totals.requesters}
                companies={data.totals.companies}
              />
            </span>
          ) : (
            <Skeleton className="mt-1 h-3.5 w-64 max-w-full rounded-sm" />
          )
        }
        descriptionClassName="text-[15px] text-ink-secondary"
      />
      <CustomerSearch urlSearch={search} />
      <div className="flex flex-col gap-3">
        <div
          ref={table}
          role="table"
          aria-label={t('title')}
          aria-busy={stale || list.isFetchingNextPage || undefined}
          className="overflow-hidden rounded-xl border border-line bg-surface"
        >
          <CustomersTableHeader />
          {body}
        </div>
        {rows && rows.length > 0 && list.hasNextPage && !stale ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              aria-disabled={list.isFetchingNextPage || undefined}
              data-load-more=""
              onClick={(event) => {
                if (list.isFetchingNextPage) return;
                if (document.activeElement === event.currentTarget) focusFrom.current = rows.length;
                void list.fetchNextPage();
              }}
            >
              {list.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
