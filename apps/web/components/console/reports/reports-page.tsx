'use client';

import { REPORT_PERIODS, type ReportPeriod, type ReportsSummary } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion } from '@/components/common/skeletons';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { Button } from '@/components/ui/button';
import { formatDuration, formatNumber } from '@/lib/format';
import { useReportsSummary } from '@/lib/reports/queries';
import { useViewer } from '@/lib/tickets/viewer';
import {
  CategoryBars,
  CategoryBarsSkeleton,
  ReportTileCard,
  ReportTilesSkeleton,
  TILE_GRID,
  type TileTone,
} from './report-tiles';
import {
  REPORT_TILES,
  isReportPeriod,
  pushReportPeriod,
  reportTileHref,
  useReportPeriod,
  type ReportTile,
} from './reports-url';

/** Tiles whose numbers depend on the period picker (the others are a snapshot of now). */
const PERIOD_TILES: ReadonlySet<ReportTile> = new Set(['solved', 'firstReply']);

function toneOf(tile: ReportTile, tiles: ReportsSummary['tiles']): TileTone {
  if (tile === 'p1Open') return tiles.p1Open > 0 ? 'danger' : 'ink';
  if (tile === 'breached') return tiles.breached > 0 ? 'overdue' : 'ink';
  if (tile === 'solved') return 'success';
  return 'ink';
}

/** Last 7 / 30 / 90 days (the design has none; F11). A radiogroup: arrows move and select. */
function PeriodPicker({
  value,
  onChange,
}: {
  value: ReportPeriod;
  onChange: (period: ReportPeriod) => void;
}) {
  const t = useTranslations('console.reports.period');
  return (
    <SegmentedControl
      aria-label={t('label')}
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (isReportPeriod(next)) onChange(next);
      }}
      options={REPORT_PERIODS.map((period) => ({ value: period, label: t(period) }))}
    />
  );
}

/** The header's subtitle: whose tickets the numbers cover (F2, scoped like the Inbox). */
function useScopeLabel(): string {
  const t = useTranslations('console.reports');
  const viewer = useViewer();
  return viewer?.role === 'SUPER_ADMIN' ? t('scopeAll') : t('scopeMine');
}

/**
 * Console Reports (design 987–1009, Phase 5 F10–F12): snapshot tiles (open, P1 open, SLA
 * breached, unassigned — now), period tiles (solved, average first reply — last 7 / 30 / 90 days
 * in `business.timezone`, `?period=` in the URL) and open tickets by category, all over the
 * tickets the viewer can see. Every tile but the average opens the matching list. Live:
 * refetched on `queue:updated` (debounced), after a reconnect, every 60 s and on
 * `config:updated` `ticket-form` / `calendar` (lib/realtime, lib/reports).
 */
export function Reports() {
  const t = useTranslations('console.reports');
  const locale = useLocale();
  const period = useReportPeriod();
  const scope = useScopeLabel();
  const summary = useReportsSummary(period);
  const data = summary.data;
  // The previous period's numbers while the new period loads.
  const stale = summary.isPlaceholderData;
  const periodLabel = t(`period.${period}`);

  let body: React.ReactNode;
  if (!data && summary.isError) {
    body = (
      <div role="alert" className="rounded-xl border border-line bg-surface">
        <EmptyState
          headingLevel="p"
          title={t('loadFailed')}
          action={
            <Button type="button" variant="outline" onClick={() => void summary.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (!data) {
    body = (
      <LoadingRegion label={t('loading')} className="flex flex-col gap-[22px]">
        <ReportTilesSkeleton />
        <CategoryBarsSkeleton />
      </LoadingRegion>
    );
  } else {
    const { tiles } = data;
    const average = tiles.firstReply.averageMinutes;
    const value = (tile: ReportTile): string | null => {
      if (tile === 'firstReply') {
        return average === null ? null : formatDuration(average * 60_000, locale);
      }
      return formatNumber(tiles[tile], locale);
    };
    const note = (tile: ReportTile): string | undefined => {
      if (tile === 'solved') return periodLabel;
      if (tile === 'firstReply') {
        return t('firstReplyNote', {
          count: tiles.firstReply.tickets,
          n: formatNumber(tiles.firstReply.tickets, locale),
          period: periodLabel,
        });
      }
      return undefined;
    };
    body = (
      <>
        <div className={TILE_GRID}>
          {REPORT_TILES.map((tile) => (
            <ReportTileCard
              key={tile}
              tile={tile}
              label={t(`tiles.${tile}`)}
              value={value(tile)}
              emptyLabel={t('noAverage')}
              tone={toneOf(tile, tiles)}
              href={reportTileHref(tile)}
              note={note(tile)}
              stale={stale && PERIOD_TILES.has(tile)}
            />
          ))}
        </div>
        <CategoryBars rows={data.byCategory} />
      </>
    );
  }

  // Rendered inside the page's ConsolePage (22 px gap between the header, tiles and bars).
  return (
    <>
      <PageHeader
        title={t('title')}
        description={scope}
        descriptionClassName="text-[15px] text-ink-secondary"
        actions={<PeriodPicker value={period} onChange={pushReportPeriod} />}
      />
      {body}
    </>
  );
}
