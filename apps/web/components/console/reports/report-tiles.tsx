'use client';

import type { ReportCategoryRow } from '@loons/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useId } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { SkeletonText, shortWidth } from '@/components/common/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';
import { localizedLabel } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import { REPORT_TILES, type ReportTile } from './reports-url';

// Design 990–1007: KPI tiles (mono label, 30 px value) in an auto-fit grid, then "Open tickets by
// category" bars. The sixth tile (average first reply, F11) keeps the design's tile style; the
// grid's minimum track is 170 px (design 200 px) so the six tiles share one row at 1280 px.

export const TILE_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5';
const TILE =
  'flex flex-col gap-2 rounded-xl border border-line bg-surface p-[18px] text-start text-ink no-underline';

/** Value colour: P1 / breached red when > 0 (design 1744–1745), solved always green. */
export type TileTone = 'ink' | 'danger' | 'overdue' | 'success';
const TONE: Record<TileTone, string> = {
  ink: 'text-ink',
  danger: 'text-danger',
  overdue: 'text-overdue',
  success: 'text-success',
};

export interface ReportTileProps {
  tile: ReportTile;
  label: string;
  /** The formatted value; `null` shows "—" with `emptyLabel` for screen readers. */
  value: string | null;
  emptyLabel?: string;
  tone: TileTone;
  /** Where the tile leads (a link), or null (a plain tile). */
  href: string | null;
  /** Muted line under the value (period tiles). */
  note?: string;
  /** The previous period's value while the new one loads. */
  stale?: boolean;
}

export function ReportTileCard({
  tile,
  label,
  value,
  emptyLabel,
  tone,
  href,
  note,
  stale = false,
}: ReportTileProps) {
  // The spaces keep the link's accessible name readable ("Unassigned 2"); flex drops them visually.
  const content = (
    <>
      <Kicker as="span">{label}</Kicker>{' '}
      <span
        data-value=""
        className={cn(
          'text-[30px] leading-tight font-semibold tabular-nums transition-opacity duration-150 ease-out',
          TONE[tone],
          stale && 'opacity-60',
        )}
      >
        {value === null ? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">{emptyLabel}</span>
          </>
        ) : (
          value
        )}
      </span>
      {note ? ' ' : null}
      {note ? (
        <span
          className={cn(
            'text-[13px] text-ink-muted transition-opacity duration-150 ease-out',
            stale && 'opacity-60',
          )}
        >
          {note}
        </span>
      ) : null}
    </>
  );
  if (!href) {
    return (
      <div data-tile={tile} aria-busy={stale || undefined} className={TILE}>
        {content}
      </div>
    );
  }
  return (
    <Link
      href={href as Route}
      prefetch={false}
      data-tile={tile}
      aria-busy={stale || undefined}
      className={cn(
        TILE,
        'transition-[border-color,box-shadow] duration-150 ease-out hover:border-brand-border hover:text-ink',
      )}
    >
      {content}
    </Link>
  );
}

/** Tiles while the first load is pending: the real labels, value placeholders. */
export function ReportTilesSkeleton() {
  const t = useTranslations('console.reports.tiles');
  return (
    <div className={TILE_GRID}>
      {REPORT_TILES.map((tile) => (
        <div key={tile} aria-hidden="true" className={TILE}>
          <Kicker as="span">{t(tile)}</Kicker>
          <Skeleton className="h-[37px] w-14 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

/**
 * "Open tickets by category" (design 998–1007, F12): every active category in admin order, zeros
 * included, then archived categories that still have open tickets (marked). Bars are relative to
 * the largest count; they grow from inline-start, so they mirror in RTL. Below `sm` the bar moves
 * under its label (390 px).
 */
export function CategoryBars({
  rows,
  stale = false,
}: {
  rows: readonly ReportCategoryRow[];
  stale?: boolean;
}) {
  const t = useTranslations('console.reports');
  const locale = useLocale();
  const titleId = useId();
  const max = Math.max(1, ...rows.map((row) => row.open));

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface p-5"
    >
      <h2 id={titleId} className="text-[15px] font-semibold text-ink">
        {t('byCategory')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-ink-muted">{t('noCategories')}</p>
      ) : (
        <ul
          aria-labelledby={titleId}
          className={cn(
            'flex flex-col gap-3.5 transition-opacity duration-150 ease-out',
            stale && 'opacity-60',
          )}
        >
          {rows.map(({ category, open }) => {
            const label = localizedLabel(category, locale);
            return (
              <li
                key={category.id}
                data-category={category.key}
                data-archived={category.isActive ? undefined : ''}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(120px,260px)_minmax(0,1fr)_30px] sm:gap-3"
              >
                <span className="min-w-0 text-ink-secondary">
                  {category.isActive ? (
                    <bdi>{label}</bdi>
                  ) : (
                    t.rich('archived', {
                      label,
                      muted: (chunks) => <span className="text-ink-muted">{chunks}</span>,
                    })
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className="col-span-2 h-2 overflow-hidden rounded-[4px] bg-surface-sunken max-sm:order-last sm:col-span-1"
                >
                  <span
                    data-bar=""
                    className="block h-full rounded-[4px] bg-brand transition-[width] duration-300 ease-out"
                    style={{ width: `${(open / max) * 100}%` }}
                  />
                </span>
                <span className="text-end font-mono text-[13px] text-ink tabular-nums">
                  {formatNumber(open, locale)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The bars while the first load is pending. */
export function CategoryBarsSkeleton() {
  const t = useTranslations('console.reports');
  return (
    <section className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-[15px] font-semibold text-ink">{t('byCategory')}</h2>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(120px,260px)_minmax(0,1fr)_30px] sm:gap-3"
        >
          <SkeletonText className={shortWidth(i + 1)} />
          <div className="col-span-2 h-2 overflow-hidden rounded-[4px] bg-surface-sunken max-sm:order-last sm:col-span-1">
            <Skeleton className="h-full w-1/3 rounded-[4px]" />
          </div>
          <SkeletonText className="ms-auto w-4" />
        </div>
      ))}
    </section>
  );
}
