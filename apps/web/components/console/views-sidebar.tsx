'use client';

import { STAFF_VIEWS, type StaffView, type TicketCounts } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { LoadingRegion, SkeletonText, shortWidth } from '@/components/common/skeletons';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/format';
import { teamName } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';
import type { InboxState } from './inbox-url';

type StaffCounts = Extract<TicketCounts, { kind: 'staff' }>;

/** A plain left click (not a new-tab / modified click) that the inbox handles in place. */
export function isPlainClick(event: React.MouseEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export interface ViewsSidebarProps {
  state: InboxState;
  counts: StaffCounts | undefined;
  countsLoading: boolean;
  hrefFor: (target: { view: StaffView } | { teamId: string }) => string;
  onNavigate: (
    target: { view: StaffView } | { teamId: string },
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => void;
  className?: string;
}

function Count({ value, loading }: { value: number | undefined; loading: boolean }) {
  const locale = useLocale();
  if (value === undefined) {
    return loading ? <Skeleton className="h-3 w-4 shrink-0 rounded-sm" /> : null;
  }
  return <span className="shrink-0 text-[13px] text-ink-muted">{formatNumber(value, locale)}</span>;
}

const ITEM =
  'flex items-center justify-between gap-2 rounded-md px-2.5 py-[9px] text-start text-[15px] whitespace-nowrap no-underline transition-[background-color,color,box-shadow] duration-150 ease-out';
const ITEM_ACTIVE = 'bg-surface text-ink shadow-segment hover:text-ink';
const ITEM_IDLE = 'text-ink-secondary hover:bg-surface hover:text-ink';

/**
 * Views + Teams column (design 709–727, ≥ 1180 px): the six staff views and the caller's teams,
 * each with its live count (realtime `queue:updated` refreshes the counts).
 */
export function ViewsSidebar({
  state,
  counts,
  countsLoading,
  hrefFor,
  onNavigate,
  className,
}: ViewsSidebarProps) {
  const t = useTranslations('console.inbox');
  const locale = useLocale();

  return (
    <aside
      className={cn(
        'flex-col gap-[22px] overflow-auto border-e border-line bg-page px-3 py-5',
        className,
      )}
    >
      <nav aria-labelledby="inbox-views-title" className="flex flex-col gap-0.5">
        <Kicker as="h2" id="inbox-views-title" className="px-2.5 pb-2">
          {t('views')}
        </Kicker>
        {STAFF_VIEWS.map((view) => {
          const active = !state.teamId && state.view === view;
          return (
            <a
              key={view}
              href={hrefFor({ view })}
              aria-current={active ? 'page' : undefined}
              onClick={(event) => onNavigate({ view }, event)}
              className={cn(ITEM, active ? ITEM_ACTIVE : ITEM_IDLE)}
            >
              <span className="truncate">{t(`view.${view}`)}</span>
              <Count value={counts?.views[view]} loading={countsLoading} />
            </a>
          );
        })}
      </nav>

      <nav aria-labelledby="inbox-teams-title" className="flex flex-col gap-0.5">
        <Kicker as="h2" id="inbox-teams-title" className="px-2.5 pb-2">
          {t('teams')}
        </Kicker>
        {counts ? (
          counts.teams.map((team) => {
            const active = state.teamId === team.id;
            return (
              <a
                key={team.id}
                href={hrefFor({ teamId: team.id })}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => onNavigate({ teamId: team.id }, event)}
                className={cn(ITEM, active ? ITEM_ACTIVE : ITEM_IDLE)}
              >
                <span className="truncate">{teamName(team, locale)}</span>
                <Count value={team.count} loading={false} />
              </a>
            );
          })
        ) : countsLoading ? (
          <LoadingRegion label={t('loadingTeams')} className="flex flex-col gap-0.5">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-[11px]">
                <SkeletonText className={cn('h-3.5', shortWidth(i + 2))} />
                <SkeletonText className="w-4" />
              </div>
            ))}
          </LoadingRegion>
        ) : null}
      </nav>
    </aside>
  );
}

export interface ViewSelectProps {
  state: InboxState;
  counts: StaffCounts | undefined;
  /** Label of the selected team when the counts don't list it (yet). */
  teamLabel?: string;
  onChange: (target: { view: StaffView } | { teamId: string }) => void;
}

/** Below 1180 px the Views column becomes this select (design `sc-raw-select` 737). */
export function ViewSelect({ state, counts, teamLabel, onChange }: ViewSelectProps) {
  const t = useTranslations('console.inbox');
  const locale = useLocale();
  const value = state.teamId ? `team:${state.teamId}` : `view:${state.view}`;
  const withCount = (label: string, count: number | undefined) =>
    count === undefined ? label : t('viewOption', { label, count: formatNumber(count, locale) });
  // Team names can end in a parenthesised acronym ("مركز العمليات الأمنية (SOC)"), so their count
  // is set off with a middle dot instead of a second pair of parentheses.
  const teamWithCount = (label: string, count: number) =>
    t('teamOption', { label, count: formatNumber(count, locale) });
  const teams = counts?.teams ?? [];
  const selectedTeamMissing = !!state.teamId && !teams.some((team) => team.id === state.teamId);

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const [kind, id] = next.split(':') as [string, string];
        if (kind === 'team') onChange({ teamId: id });
        else if ((STAFF_VIEWS as readonly string[]).includes(id))
          onChange({ view: id as StaffView });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={t('chooseView')}
        className="w-full min-w-0 border-line text-[15px] font-semibold"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectGroup>
          <SelectLabel>{t('views')}</SelectLabel>
          {STAFF_VIEWS.map((view) => (
            <SelectItem key={view} value={`view:${view}`}>
              {withCount(t(`view.${view}`), counts?.views[view])}
            </SelectItem>
          ))}
        </SelectGroup>
        {teams.length || selectedTeamMissing ? (
          <SelectGroup>
            <SelectLabel>{t('teams')}</SelectLabel>
            {teams.map((team) => (
              <SelectItem key={team.id} value={`team:${team.id}`}>
                {teamWithCount(teamName(team, locale), team.count)}
              </SelectItem>
            ))}
            {selectedTeamMissing ? (
              <SelectItem value={value}>{teamLabel ?? t('team')}</SelectItem>
            ) : null}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
