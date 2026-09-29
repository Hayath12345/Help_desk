'use client';

import { slaState, type SlaFields, type SlaState } from '@loons/shared';
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
 * "Replied", "Paused" (PENDING) or the done status. Mono 12px, coloured by `slaTone`.
 */
export function SlaText({ ticket, now, className }: SlaTextProps) {
  const t = useTranslations('tickets.sla');
  const tStatus = useTranslations('common.status');
  const locale = useLocale();
  const clock = useNow({ updateInterval: 30_000 });
  const state = slaState(ticket, now ?? clock.getTime());
  const tone = slaTone(state);

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
      text = t('replied');
      label = t('repliedLabel');
      break;
    case 'firstReply': {
      const duration = formatDuration(Math.abs(state.clock.remainingMs), locale);
      text = state.clock.overdue ? t('overdue', { duration }) : duration;
      label = state.clock.overdue
        ? t('firstReplyOverdue', { duration })
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
