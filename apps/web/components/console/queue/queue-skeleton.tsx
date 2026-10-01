import { QUEUE_TABS } from '@loons/shared';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, SkeletonText, lineWidth, shortWidth } from '@/components/common/skeletons';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AGENT_GRID, QUEUE_CARD, QUEUE_GRID, QUEUE_ROW, QUEUE_TABLE_WIDTH } from './layout';

// The Team queue's loading states (route `loading.tsx`, the page's Suspense fallback, and the
// table / cards while their data loads): the real layout with skeletons, never spinners.
// Server-compatible (no client hooks).

const FILTER_KEYS = ['priorityAny', 'categoryAny', 'assigneeAny'] as const;

export function AgentCardSkeleton({ index }: { index: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface px-[18px] py-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-8 shrink-0 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <SkeletonText className={shortWidth(index)} />
          <SkeletonText className="w-16" />
        </div>
        <Skeleton className="h-6 w-5 rounded-sm" />
      </div>
      <Skeleton className="h-1 w-full rounded-full" />
      <SkeletonText className="w-32" />
    </div>
  );
}

/**
 * Four placeholder agent cards (design 902–914). With `label` they announce themselves as
 * loading; without, they sit inside a larger loading region.
 */
export function AgentCardsSkeleton({ label }: { label?: string }) {
  const cards = Array.from({ length: 4 }, (_, i) => <AgentCardSkeleton key={i} index={i} />);
  return label ? (
    <LoadingRegion label={label} className={AGENT_GRID}>
      {cards}
    </LoadingRegion>
  ) : (
    <div className={AGENT_GRID}>{cards}</div>
  );
}

/** One placeholder row, in the same grid (or phone card) as the real rows. */
export function QueueRowSkeleton({ index }: { index: number }) {
  return (
    <div className={cn(QUEUE_ROW, QUEUE_GRID)}>
      <Skeleton className="size-4 rounded-[4px]" />
      <Skeleton className="h-5 w-[72px] rounded-sm" />
      <div className="order-4 flex w-full min-w-0 flex-col gap-1.5 md:order-none md:w-auto">
        <SkeletonText className={cn('h-3.5', lineWidth(index))} />
        <SkeletonText className="w-32" />
      </div>
      <div className="order-5 flex w-full min-w-0 flex-col gap-1.5 md:order-none md:w-auto">
        <SkeletonText className={shortWidth(index + 1)} />
        <SkeletonText className="w-20" />
      </div>
      <div className="order-6 flex min-w-0 flex-1 flex-col gap-2 md:order-none">
        <SkeletonText className="w-14" />
        <Skeleton className="h-[3px] w-full rounded-full" />
      </div>
      <SkeletonText className={cn('order-7 md:order-none', shortWidth(index + 3))} />
      <Skeleton className="order-3 ms-auto h-5 w-16 rounded-full md:order-none md:ms-0" />
    </div>
  );
}

export interface QueueTableHeadProps {
  /** The select-all checkbox (the live table); the skeleton shows an empty box. */
  selectAll?: React.ReactNode;
  /** Visible "Select all" caption next to the checkbox on phones (no column headers there). */
  selectAllCaption?: string;
  /** ARIA table roles (the live table); off in the skeleton, which is no table yet. */
  roles?: boolean;
}

/**
 * Header row (design 943–945): mono 11px uppercase labels, 12px vertical padding, divider. On
 * phones the column labels are only for screen readers (the rows are stacked cards) and the row
 * keeps the select-all checkbox.
 */
export function QueueTableHead({
  selectAll,
  selectAllCaption,
  roles = false,
}: QueueTableHeadProps) {
  const t = useTranslations('console.queue');
  const labels = [
    t('columns.priority'),
    t('columns.ticket'),
    t('columns.requester'),
    t('columns.firstReplySla'),
    t('columns.assignee'),
    t('columns.status'),
  ];
  return (
    <div
      role={roles ? 'row' : undefined}
      className={cn(
        'flex items-center gap-3 border-b border-divider px-4 py-3 md:ps-[18px] md:pe-4',
        QUEUE_GRID,
      )}
    >
      <span role={roles ? 'columnheader' : undefined} className="flex items-center gap-2.5">
        {selectAll ?? <Skeleton className="size-4 rounded-[4px]" />}
        {selectAllCaption ? (
          <Kicker as="span" aria-hidden="true" className="md:hidden">
            {selectAllCaption}
          </Kicker>
        ) : null}
      </span>
      {labels.map((label) => (
        <Kicker
          as="span"
          key={label}
          role={roles ? 'columnheader' : undefined}
          className="truncate max-md:sr-only"
        >
          {label}
        </Kicker>
      ))}
    </div>
  );
}

/** Placeholder rows (inside the live table while the first page loads). */
export function QueueRowsSkeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <LoadingRegion label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <QueueRowSkeleton key={i} index={i} />
      ))}
    </LoadingRegion>
  );
}

/**
 * The whole page body while the route loads (inside `ConsolePage`): header, agent cards, the tab
 * and filter row and the table, as in the design.
 */
export function QueueSkeleton() {
  const t = useTranslations('console.queue');
  return (
    <>
      <PageHeader
        className="items-start"
        title={t('title')}
        description={<Skeleton className="my-1 h-3.5 w-44 rounded-sm" />}
        descriptionClassName="text-[15px] text-ink-secondary"
        actions={<NewTicketButton size="lg" className="text-[15px]" />}
      />
      <LoadingRegion label={t('loading')} className="flex flex-col gap-[22px]">
        <AgentCardsSkeleton />
        <div
          aria-hidden="true"
          className="flex flex-wrap items-end justify-between gap-4 border-b border-line"
        >
          <div className="flex max-w-full min-w-0 gap-[22px] overflow-hidden">
            {QUEUE_TABS.map((key, i) => (
              <span
                key={key}
                className={cn(
                  '-mb-px inline-flex items-center gap-1.5 border-b-2 pb-2.5 text-[15px] font-medium whitespace-nowrap',
                  i === 0 ? 'border-ink text-ink' : 'border-transparent text-ink-muted',
                )}
              >
                {t(`tabs.${key}`)}
                <Skeleton className="h-2.5 w-3 rounded-sm" />
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 pb-2">
            {/* Quieter than the live filters, still 4.5:1 (ink-muted; no opacity on text). */}
            {FILTER_KEYS.map((key) => (
              <span
                key={key}
                data-filter-placeholder=""
                className="inline-flex items-center gap-1 rounded-sm border border-transparent px-1 py-[3px] text-sm text-ink-muted"
              >
                {t(`filters.${key}`)}
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </span>
            ))}
          </div>
        </div>
        <div className={QUEUE_CARD}>
          <div className={QUEUE_TABLE_WIDTH}>
            <QueueTableHead />
            {Array.from({ length: 6 }, (_, i) => (
              <QueueRowSkeleton key={i} index={i} />
            ))}
          </div>
        </div>
      </LoadingRegion>
    </>
  );
}
