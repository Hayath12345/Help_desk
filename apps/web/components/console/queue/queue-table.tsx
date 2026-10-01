'use client';

import type { TicketSummaryDto } from '@loons/shared';
import { AnimatePresence } from 'motion/react';
import { useNow, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { QUEUE_CARD, QUEUE_TABLE_WIDTH } from './layout';
import { QueueRow } from './queue-row';
import { QueueRowSkeleton, QueueRowsSkeleton, QueueTableHead } from './queue-skeleton';

export interface QueueTableProps {
  items: readonly TicketSummaryDto[];
  /** First load (no rows yet). */
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Showing the previous tab's / filter's rows while the new ones load. */
  isStale: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  isSelected: (ticket: TicketSummaryDto) => boolean;
  onSelectedChange: (ticket: TicketSummaryDto, selected: boolean) => void;
  /** Select-all header checkbox: every loaded row, or none. */
  onSelectAll: (selected: boolean) => void;
  onOpen: (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => void;
  selectAllRef?: React.Ref<HTMLButtonElement>;
}

/**
 * The queue table (design 941–961): a white card with the mono header row (select-all checkbox
 * for the loaded rows) and the rows; skeleton rows while loading, "No tickets match these
 * filters." when empty (every tab), an error with Try again, and "Show more tickets" for the next
 * page. From `md` it is the design's grid (min 980 px, scrolling inside the card); on phones the
 * rows are stacked cards. Focus is never dropped: the select-all checkbox stays focusable (only
 * aria-disabled) when the list empties, and "Show more tickets" stays in place while the page
 * loads, then hands the focus to the first new row.
 */
export function QueueTable({
  items,
  isLoading,
  isError,
  onRetry,
  isStale,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  isSelected,
  onSelectedChange,
  onSelectAll,
  onOpen,
  selectAllRef,
}: QueueTableProps) {
  const t = useTranslations('console.queue');
  // One clock for every row, so the countdowns agree (and move on without refetching).
  const now = useNow({ updateInterval: 30_000 }).getTime();
  const card = useRef<HTMLDivElement>(null);
  // "Show more tickets" pressed with the focus on it: the focus continues on the first new row.
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || items.length <= from) return;
    focusFrom.current = null;
    card.current?.querySelectorAll<HTMLElement>('[data-row-open]')[from]?.focus();
  }, [items.length]);

  const selectedCount = items.filter(isSelected).length;
  const allSelected = items.length > 0 && selectedCount === items.length;
  const checked = allSelected ? true : selectedCount > 0 ? 'indeterminate' : false;

  let state: React.ReactNode = null;
  // First load, or another tab / filter loading after an empty list: skeleton rows.
  if (isLoading || (isStale && items.length === 0)) {
    state = <QueueRowsSkeleton label={t('loading')} />;
  } else if (isError && items.length === 0) {
    state = (
      <div role="alert">
        <EmptyState
          headingLevel="p"
          className="py-9"
          title={t('loadFailed')}
          action={
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (items.length === 0) {
    // Design 957–959: the same sentence on every tab.
    state = (
      <p role="status" className="p-9 text-center text-ink-muted">
        {t('noMatch')}
      </p>
    );
  }

  return (
    <div ref={card} className={QUEUE_CARD}>
      <div className={QUEUE_TABLE_WIDTH}>
        <div
          role="table"
          aria-label={t('listLabel')}
          aria-busy={isStale || isFetchingNextPage || undefined}
          className={cn(
            'transition-opacity duration-150 ease-out',
            isStale && items.length > 0 && 'opacity-60',
          )}
        >
          <div role="rowgroup">
            <QueueTableHead
              roles
              selectAllCaption={items.length ? t('selectAllShort') : undefined}
              selectAll={
                // aria-disabled, never disabled: it keeps the focus when a bulk action empties
                // the list (a disabled control would drop it to the page).
                <Checkbox
                  ref={selectAllRef}
                  checked={checked}
                  aria-disabled={items.length === 0 || undefined}
                  onCheckedChange={() => {
                    if (items.length > 0) onSelectAll(!allSelected);
                  }}
                  aria-label={t('selectAll')}
                  data-select-all=""
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                />
              }
            />
          </div>
          {items.length > 0 && !isLoading ? (
            <div role="rowgroup">
              <AnimatePresence initial={false} mode="popLayout">
                {items.map((ticket) => (
                  <QueueRow
                    key={ticket.id}
                    ticket={ticket}
                    now={now}
                    selected={isSelected(ticket)}
                    onSelectedChange={onSelectedChange}
                    onOpen={onOpen}
                  />
                ))}
              </AnimatePresence>
            </div>
          ) : null}
        </div>
        {state}
        {isFetchingNextPage ? (
          // The button below says "Loading more tickets…" (and keeps the focus).
          <div aria-hidden="true" className="border-t border-divider">
            <QueueRowSkeleton index={items.length} />
            <QueueRowSkeleton index={items.length + 1} />
          </div>
        ) : null}
        {hasNextPage && !isStale && items.length > 0 ? (
          <div className="flex justify-center border-t border-divider px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-disabled={isFetchingNextPage || undefined}
              data-load-more=""
              onClick={(event) => {
                if (isFetchingNextPage) return;
                if (document.activeElement === event.currentTarget)
                  focusFrom.current = items.length;
                onLoadMore();
              }}
            >
              {isFetchingNextPage ? t('loadingMore') : t('loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
