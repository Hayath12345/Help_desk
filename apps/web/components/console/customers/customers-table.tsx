'use client';

import type { CustomerRow } from '@loons/shared';
import { motion } from 'motion/react';
import type { Route } from 'next';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { InitialsAvatar } from '@/components/common/initials-avatar';
import { Kicker } from '@/components/common/kicker';
import { SkeletonText, shortWidth } from '@/components/common/skeletons';
import { ContractBadge } from '@/components/tickets/org-chip';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber, initialsFrom, isolate } from '@/lib/format';
import { listItemVariants, transitions } from '@/lib/motion';
import { placeName } from '@/lib/tickets/labels';
import { TRUNCATE_ANY_DIRECTION, cn } from '@/lib/utils';
import { inboxHref } from '../inbox-url';

// Design 971–983: requester · client · contract · open · total in a white card (1280 px). Below
// `md` every row stacks (390 px): the requester, then the company with its contract pill, then
// the open / total counts with their column names inline.

/** Grid of the header and body rows: two tracks when stacked, the design's five from `md`. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_90px_90px] md:gap-x-2.5 md:gap-y-0';
const ROW_PADDING = 'px-4 py-3 md:px-[18px]';
/** Cells under the name line up with it when stacked (30 px avatar + 10 px gap). */
const UNDER_NAME = 'ps-10 md:ps-0';
const END_CELL = 'justify-self-end md:justify-self-auto';

/** Header row: mono column names (sr-only when stacked, where each cell carries its name). */
export function CustomersTableHeader() {
  const t = useTranslations('console.customers.columns');
  const labels = [
    { key: 'requester', className: undefined },
    { key: 'client', className: undefined },
    { key: 'contract', className: undefined },
    { key: 'open', className: 'text-end' },
    { key: 'total', className: 'text-end' },
  ] as const;
  return (
    <div role="rowgroup">
      <div
        role="row"
        className={cn(
          GRID,
          'items-center border-b border-divider py-3 max-md:sr-only md:px-[18px]',
        )}
      >
        {labels.map(({ key, className }) => (
          <Kicker as="span" key={key} role="columnheader" className={cn('truncate', className)}>
            {t(key)}
          </Kicker>
        ))}
      </div>
    </div>
  );
}

/** A loading row with the real row's shape. */
export function CustomerRowSkeleton({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      className={cn(GRID, ROW_PADDING, 'items-center border-b border-divider last:border-b-0')}
    >
      <div className="col-span-2 flex min-w-0 items-center gap-2.5 md:col-span-1">
        <Skeleton className="size-[30px] shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <SkeletonText className={shortWidth(index)} />
          <SkeletonText className="w-40 max-w-full" />
        </div>
      </div>
      <SkeletonText className={cn(shortWidth(index + 2), 'max-md:ms-10')} />
      <Skeleton className={cn('h-5 w-12 rounded-sm', END_CELL)} />
      <SkeletonText className="w-5 max-md:ms-10 md:ms-auto" />
      <SkeletonText className={cn('w-5 md:ms-auto', END_CELL)} />
    </div>
  );
}

/**
 * One requester. The name is the row's link (its overlay covers the whole row) to the Inbox
 * company view of their organisation (F9, design 1738); the counts cover only the tickets the
 * viewer can see (F8).
 */
export function CustomerTableRow({ row }: { row: CustomerRow }) {
  const t = useTranslations('console.customers');
  const locale = useLocale();
  const company = placeName(row.org, locale);

  return (
    <motion.div
      role="row"
      layout="position"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ layout: transitions.layout }}
      data-customer={row.id}
      className={cn(
        GRID,
        ROW_PADDING,
        'relative items-center border-b border-divider bg-surface transition-colors duration-150 ease-out last:border-b-0 hover:bg-surface-muted',
        'has-[[data-row-open]:focus-visible]:bg-surface-muted has-[[data-row-open]:focus-visible]:outline-hidden has-[[data-row-open]:focus-visible]:ring-2 has-[[data-row-open]:focus-visible]:ring-brand has-[[data-row-open]:focus-visible]:ring-inset forced-colors:has-[[data-row-open]:focus-visible]:-outline-offset-2',
      )}
    >
      <div role="cell" className="col-span-2 flex min-w-0 items-center gap-2.5 md:col-span-1">
        <InitialsAvatar initials={initialsFrom(row.name) || '?'} variant="track" size="sm" />
        <div className="flex min-w-0 flex-col">
          <Link
            href={inboxHref({ orgId: row.org.id }) as Route}
            prefetch={false}
            data-row-open=""
            dir="auto"
            aria-label={t('rowLabel', { name: isolate(row.name), company: isolate(company) })}
            className={cn(
              'min-w-0 font-medium text-ink no-underline outline-none after:absolute after:inset-0 hover:text-ink focus-visible:outline-hidden',
              TRUNCATE_ANY_DIRECTION,
            )}
          >
            {row.name}
          </Link>
          <span dir="ltr" className="truncate text-start text-[13px] text-ink-muted rtl:text-end">
            {row.email}
          </span>
        </div>
      </div>
      <div role="cell" className={cn('flex min-w-0 text-ink', UNDER_NAME)}>
        <span dir="auto" className={cn('min-w-0', TRUNCATE_ANY_DIRECTION)}>
          {company}
        </span>
      </div>
      <div role="cell" className={END_CELL}>
        <ContractBadge
          contract={row.org.contractType}
          className="rounded-sm px-2 text-xs font-semibold"
        />
      </div>
      <div role="cell" className={cn('flex items-baseline gap-1.5 md:justify-end', UNDER_NAME)}>
        <Kicker as="span" aria-hidden="true" className="md:hidden">
          {t('columns.open')}
        </Kicker>
        <span className="font-mono text-[13px] text-ink tabular-nums">
          {formatNumber(row.open, locale)}
        </span>
      </div>
      <div role="cell" className={cn('flex items-baseline gap-1.5 md:justify-end', END_CELL)}>
        <Kicker as="span" aria-hidden="true" className="md:hidden">
          {t('columns.total')}
        </Kicker>
        <span className="font-mono text-[13px] text-ink-muted tabular-nums">
          {formatNumber(row.total, locale)}
        </span>
      </div>
    </motion.div>
  );
}
