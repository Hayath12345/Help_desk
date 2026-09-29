'use client';

import { slaState, type SlaClock, type SlaFields, type SlaState } from '@loons/shared';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

export type SlaTone = 'ok' | 'risk' | 'overdue' | 'done' | 'paused' | 'replied';

/** Which colour the list text / SLA card uses for a state (design `sla()`: green / amber / red / grey). */
export function slaTone(state: SlaState): SlaTone {
  switch (state.kind) {
    case 'done':
      return 'done';
    case 'paused':
      return 'paused';
    case 'replied':
      return 'replied';
    case 'firstReply':
      return state.clock.overdue ? 'overdue' : state.clock.atRisk ? 'risk' : 'ok';
  }
}

/**
 * The resolution clock a list row shows instead of "Replied" (D1): once the first reply is sent
 * the row says "Replied" — unless the running resolution target has reached its stored at-risk
 * instant or passed its due date, so every row in the "SLA at risk" view shows why it is there.
 */
export function rowResolutionClock(state: SlaState): SlaClock | null {
  if (state.kind !== 'replied' || !state.resolution) return null;
  return state.resolution.atRisk || state.resolution.overdue ? state.resolution : null;
}

/** The list row's tone: `slaTone`, or the resolution clock's when the row shows it. */
export function slaRowTone(state: SlaState): SlaTone {
  const resolution = rowResolutionClock(state);
  if (!resolution) return slaTone(state);
  return resolution.overdue ? 'overdue' : 'risk';
}

/**
 * Text colour per tone. The design's greens / oranges are below 4.5:1 on white at 12px, so the
 * AA-safe token shades are used (success, P2 amber, danger).
 */
export const SLA_TONE_TEXT: Record<SlaTone, string> = {
  ok: 'text-success',
  risk: 'text-p2-fg',
  overdue: 'text-danger',
  done: 'text-ink-muted',
  paused: 'text-status-pending-fg',
  replied: 'text-success',
};

/** Bar colour per tone (the SLA card's progress bar). */
export const SLA_TONE_BAR: Record<SlaTone, string> = {
  ok: 'bg-success-strong',
  risk: 'bg-warning-strong',
  overdue: 'bg-danger-strong',
  done: 'bg-line-dashed',
  paused: 'bg-status-pending-fg',
  replied: 'bg-success-strong',
};

export interface SlaTextProps {
  ticket: SlaFields;
  /** Shared clock (ms) so every row agrees; defaults to a 30-second ticking clock. */
  now?: number;
  className?: string;
}

/**
 * The list's SLA cell (design inbox row): first-reply countdown ("9m", "1h 05m"), "Overdue 12m",
 * "Replied", "Paused" (PENDING) or the done status. Mono 12px, coloured by `slaRowTone`. After
 * the first reply, a resolution target at risk or overdue replaces "Replied" (`rowResolutionClock`).
 */
export function SlaText({ ticket, now, className }: SlaTextProps) {
  const t = useTranslations('tickets.sla');
  const tStatus = useTranslations('common.status');
  const locale = useLocale();
  const clock = useNow({ updateInterval: 30_000 });
  const state = slaState(ticket, now ?? clock.getTime());
  const tone = slaRowTone(state);
  const resolution = rowResolutionClock(state);

  let text: string;
  let label: string | undefined;
  switch (state.kind) {
    case 'done':
      text = tStatus(ticket.status);
      break;
    case 'paused':
      text = t('paused');
      label = t('pausedLabel');
      break;
    case 'replied':
      if (resolution) {
        const duration = formatDuration(Math.abs(resolution.remainingMs), locale);
        text = resolution.overdue ? t('overdue', { duration }) : duration;
        // Shown only when at risk or overdue: the words say so (not only the amber colour).
        label = resolution.overdue
          ? t('resolutionOverdueLabel', { duration })
          : t('resolutionInAtRisk', { duration });
      } else {
        text = t('replied');
        label = t('repliedLabel');
      }
      break;
    case 'firstReply': {
      const duration = formatDuration(Math.abs(state.clock.remainingMs), locale);
      text = state.clock.overdue ? t('overdue', { duration }) : duration;
      label = state.clock.overdue
        ? t('firstReplyOverdue', { duration })
        : state.clock.atRisk
          ? t('firstReplyInAtRisk', { duration })
          : t('firstReplyIn', { duration });
      break;
    }
  }

  return (
    <span
      data-sla={tone}
      className={cn(
        'font-mono text-xs whitespace-nowrap transition-colors duration-200 ease-out',
        SLA_TONE_TEXT[tone],
        className,
      )}
    >
      {label ? (
        <>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{label}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}
