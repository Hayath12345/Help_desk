'use client';

import type { Workload, WorkloadAgent } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { InitialsAvatar } from '@/components/common/initials-avatar';
import { Button } from '@/components/ui/button';
import { formatNumber, initialsFrom } from '@/lib/format';
import { teamName } from '@/lib/tickets/labels';
import { TRUNCATE_ANY_DIRECTION, cn } from '@/lib/utils';
import { AGENT_GRID } from './layout';
import { AgentCardsSkeleton } from './queue-skeleton';

export interface AgentCardsProps {
  workload: Workload | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** The Assignee filter (a staff id, "none" or null): the matching card shows as pressed. */
  assigneeId: string | null;
  /** Card click: toggles the Assignee filter to that agent (again = everyone). */
  onToggle: (agentId: string) => void;
}

/**
 * Agent workload cards (design 902–914, F5): one per active staff member of the visible teams,
 * most loaded first — their open tickets against a capacity of AGENT_QUEUE_CAPACITY (the bar is
 * always brand, full at capacity) and "N at risk" (red) or "On track". A card is a toggle button
 * for the Assignee filter (`aria-pressed`; brand border while pressed). No presence dot (F5).
 */
export function AgentCards({
  workload,
  isLoading,
  isError,
  onRetry,
  assigneeId,
  onToggle,
}: AgentCardsProps) {
  const t = useTranslations('console.queue');
  const hintId = useId();

  if (!workload) {
    if (isLoading) return <AgentCardsSkeleton label={t('loading')} />;
    if (isError) {
      return (
        <section aria-label={t('agentsLabel')} className="rounded-xl border border-line bg-surface">
          <div role="alert">
            <EmptyState
              headingLevel="p"
              className="gap-2 py-6"
              title={t('agentsFailed')}
              action={
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                  {t('retry')}
                </Button>
              }
            />
          </div>
        </section>
      );
    }
    return null;
  }
  if (workload.agents.length === 0) return null;

  return (
    <section aria-label={t('agentsLabel')} aria-describedby={hintId} className={AGENT_GRID}>
      <p id={hintId} className="sr-only">
        {t('agentsHint')}
      </p>
      {workload.agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          capacity={workload.capacity}
          pressed={assigneeId === agent.id}
          describedBy={hintId}
          onToggle={onToggle}
        />
      ))}
    </section>
  );
}

function AgentCard({
  agent,
  capacity,
  pressed,
  describedBy,
  onToggle,
}: {
  agent: WorkloadAgent;
  capacity: number;
  pressed: boolean;
  describedBy: string;
  onToggle: (agentId: string) => void;
}) {
  const t = useTranslations('console.queue.agent');
  const locale = useLocale();
  const n = (value: number) => formatNumber(value, locale);
  const [firstTeam, ...otherTeams] = agent.teams;
  const team = firstTeam
    ? otherTeams.length
      ? t('moreTeams', { team: teamName(firstTeam, locale), n: n(otherTeams.length) })
      : teamName(firstTeam, locale)
    : null;
  const percent = Math.min(100, (agent.open / Math.max(1, capacity)) * 100);
  const status = agent.atRisk
    ? t('atRisk', { count: agent.atRisk, n: n(agent.atRisk) })
    : t('onTrack');

  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-describedby={describedBy}
      data-agent-id={agent.id}
      onClick={() => onToggle(agent.id)}
      className={cn(
        'flex min-w-0 cursor-pointer flex-col gap-3 rounded-xl border bg-surface px-[18px] py-4 text-start transition-[border-color,box-shadow] duration-150 ease-out outline-none hover:border-brand-border focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand',
        // Forced colours flatten the brand border: the pressed card gets a thicker Highlight one.
        pressed
          ? 'border-brand hover:border-brand forced-colors:border-2 forced-colors:border-[Highlight] forced-colors:px-[17px] forced-colors:py-[15px]'
          : 'border-line',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2.5">
        <InitialsAvatar initials={initialsFrom(agent.name) || '?'} size="md" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            dir="auto"
            className={cn('text-[15px] font-semibold text-ink', TRUNCATE_ANY_DIRECTION)}
          >
            {agent.name}
          </span>
          {team ? <span className="truncate text-[13px] text-ink-muted">{team}</span> : null}
        </span>
        <span className="text-[22px] leading-none font-semibold text-ink tabular-nums">
          <span aria-hidden="true">{n(agent.open)}</span>
          <span className="sr-only">{t('openCount', { count: agent.open, n: n(agent.open) })}</span>
        </span>
      </span>
      <span aria-hidden="true" className="block h-1 w-full overflow-hidden rounded-[2px] bg-track">
        <span
          data-capacity-bar=""
          className="block h-full bg-brand transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </span>
      {/* The design's overdue red is 4.4:1 at 13px: the AA-safe danger shade says "at risk". */}
      <span
        data-at-risk={agent.atRisk > 0 || undefined}
        className={cn('text-[13px]', agent.atRisk ? 'text-danger' : 'text-ink-secondary')}
      >
        {t('note', { status, capacity: t('capacity', { n: n(capacity) }) })}
      </span>
    </button>
  );
}
