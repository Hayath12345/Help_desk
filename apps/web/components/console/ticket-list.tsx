'use client';

import type { TicketSort, TicketSummaryDto } from '@loons/shared';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { LoadingRegion, TicketListRowSkeleton } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TicketRow } from './ticket-row';

const SKELETON_ROWS = 7;

export interface TicketListProps {
  /** Heading of the list: the view or team name. */
  title: string;
  /** Shown next to the title (design: muted count); null while unknown. */
  count: number | null;
  /** Rendered instead of the title below 1180 px (the Views column collapses into a select). */
  viewSelect: React.ReactNode;
  sort: TicketSort;
  onSortChange: (sort: TicketSort) => void;
  items: readonly TicketSummaryDto[];
  /** First load (no rows yet). */
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Showing the previous filter's rows while the new ones load. */
  isStale: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** The active search, for the empty state. */
  search: string;
  isSelected: (ticket: TicketSummaryDto) => boolean;
  hrefFor: (ticket: TicketSummaryDto) => string;
  onSelect: (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => void;
  onPrefetch?: (ticket: TicketSummaryDto) => void;
  className?: string;
}

/**
 * Ticket list column (design 730–764): header with the view title + count (or the view select
 * on narrower screens) and the SLA / recent sort toggle, then the rows. Loads more rows when
 * the end scrolls into view; skeletons while loading, never spinners.
 */
export function TicketList({
  title,
  count,
  viewSelect,
  sort,
  onSortChange,
  items,
  isLoading,
  isError,
  onRetry,
  isStale,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  search,
  isSelected,
  hrefFor,
  onSelect,
  onPrefetch,
  className,
}: TicketListProps) {
  const t = useTranslations('console.inbox');
  const locale = useLocale();
  const now = useNow({ updateInterval: 30_000 }).getTime();
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMore = useRef(onLoadMore);
  useEffect(() => {
    loadMore.current = onLoadMore;
  });

  // Infinite scroll: fetch the next page when the end of the list comes into view.
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore.current();
      },
      { root: scroller.current, rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, items.length]);

  const nextSort: TicketSort = sort === 'sla' ? 'recent' : 'sla';

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <LoadingRegion label={t('loadingTickets')}>
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <TicketListRowSkeleton key={i} index={i} />
        ))}
      </LoadingRegion>
    );
  } else if (isError && items.length === 0) {
    body = (
      <EmptyState
        headingLevel="p"
        title={t('loadFailed')}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        headingLevel="p"
        className="gap-1.5 py-10"
        title={t('nothingHere')}
        description={search ? t('noMatchSearch', { query: search }) : t('noMatchView')}
      />
    );
  } else {
    body = (
      <>
        <ul
          aria-label={t('listLabel')}
          aria-busy={isStale || undefined}
          className={cn(
            'relative transition-opacity duration-150 ease-out',
            isStale && 'opacity-60',
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {items.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                href={hrefFor(ticket)}
                selected={isSelected(ticket)}
                now={now}
                onSelect={onSelect}
                onPrefetch={onPrefetch}
              />
            ))}
          </AnimatePresence>
        </ul>
        {isFetchingNextPage ? (
          <LoadingRegion label={t('loadingMore')}>
            <TicketListRowSkeleton index={items.length} />
            <TicketListRowSkeleton index={items.length + 1} />
          </LoadingRegion>
        ) : null}
        {hasNextPage && !isFetchingNextPage ? (
          <div ref={sentinel} className="flex justify-center p-3">
            <Button type="button" variant="ghost" size="sm" onClick={onLoadMore}>
              {t('loadMore')}
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section
      aria-labelledby="inbox-list-title"
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
    >
      <div className="flex items-center justify-between gap-2.5 border-b border-divider px-5 py-[18px]">
        <h2
          id="inbox-list-title"
          className="flex min-w-0 items-baseline gap-1.5 text-[17px] font-semibold whitespace-nowrap text-ink max-[1179px]:sr-only"
        >
          <span className="truncate">{title}</span>
          {count !== null ? (
            <span className="text-sm font-normal text-ink-muted">
              {formatNumber(count, locale)}
            </span>
          ) : null}
        </h2>
        <div className="max-w-[62%] min-w-0 flex-[1_1_auto] min-[1180px]:hidden">{viewSelect}</div>
        <button
          type="button"
          onClick={() => onSortChange(nextSort)}
          aria-label={t('sort.toggle', { current: t(`sort.${sort}`), next: t(`sort.${nextSort}`) })}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-[13px] whitespace-nowrap text-ink-muted transition-colors duration-150 ease-out hover:text-ink"
        >
          {t(`sort.${sort}`)}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </section>
  );
}
