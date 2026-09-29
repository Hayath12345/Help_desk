'use client';

import {
  slaState,
  type SlaClock,
  type SlaFields,
  type TicketDetailDto,
  type TicketStatus,
} from '@loons/shared';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useId } from 'react';
import { Kicker } from '@/components/common/kicker';
import { SLA_TONE_BAR, SLA_TONE_TEXT, slaTone, type SlaTone } from '@/components/tickets/sla-text';
import { formatDuration } from '@/lib/format';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';

export interface SlaCardModel {
  /** "First reply due" while the first reply is outstanding, "First reply" afterwards. */
  kicker: 'firstReplyDue' | 'firstReply';
  tone: SlaTone;
  value:
    | { kind: 'countdown'; ms: number; overdue: boolean }
    | { kind: 'replied' }
    | { kind: 'paused' }
    | { kind: 'done'; status: TicketStatus };
  /** Progress bar fill, 0–100 (design: remaining share of the window, at least 4%). */
  percent: number;
  /** The running resolution clock once the first reply is sent (shown on the target line). */
  resolution: SlaClock | null;
  /**
   * PENDING: the resolution clock is stopped (spec §7) — said on the target line, since the big
   * value may be the first-reply countdown, which keeps running.
   */
  resolutionPaused: boolean;
}

/** What the SLA card shows for a ticket at `now` (design `sla()` + the right-panel card). */
export function slaCardModel(ticket: SlaFields, now: number): SlaCardModel {
  const state = slaState(ticket, now);
  const tone = slaTone(state);
  switch (state.kind) {
    case 'firstReply': {
      const { remainingMs, windowMs, overdue } = state.clock;
      const percent = overdue ? 100 : Math.max(4, Math.min(100, (remainingMs / windowMs) * 100));
      return {
        kicker: 'firstReplyDue',
        tone,
        value: { kind: 'countdown', ms: Math.abs(remainingMs), overdue },
        percent,
        resolution: null,
        // An unanswered PENDING ticket: the first-reply clock runs, the resolution clock doesn't.
        resolutionPaused: 'resolutionPaused' in state && state.resolutionPaused === true,
      };
    }
    case 'replied':
      return {
        kicker: 'firstReply',
        tone,
        value: { kind: 'replied' },
        percent: 100,
        resolution: state.resolution,
        resolutionPaused: false,
      };
    case 'paused':
      return {
        kicker: 'firstReply',
        tone,
        value: { kind: 'paused' },
        percent: 100,
        resolution: null,
        resolutionPaused: true,
      };
    case 'done':
      return {
        kicker: 'firstReply',
        tone,
        value: { kind: 'done', status: ticket.status },
        percent: 100,
        resolution: null,
        resolutionPaused: false,
      };
  }
}

/**
 * Right-panel SLA card (design 815–820): kicker + policy window, the big countdown coloured by
 * the SLA state, the progress bar and the resolution target. Ticks every 15 s.
 */
export function SlaCard({
  ticket,
  className,
}: {
  ticket: Pick<TicketDetailDto, keyof SlaFields | 'sla'>;
  className?: string;
}) {
  const t = useTranslations('console.panel.sla');
  const tSla = useTranslations('tickets.sla');
  const tStatus = useTranslations('common.status');
  const locale = useLocale();
  const formatWindow = useSlaWindowFormatter();
  const now = useNow({ updateInterval: 15_000 }).getTime();
  const titleId = useId();
  const model = slaCardModel(ticket, now);

  let big: string;
  let spoken: string;
  switch (model.value.kind) {
    case 'countdown': {
      const duration = formatDuration(model.value.ms, locale);
      big = model.value.overdue ? tSla('overdue', { duration }) : duration;
      spoken = model.value.overdue
        ? tSla('firstReplyOverdue', { duration })
        : tSla('firstReplyIn', { duration });
      break;
    }
    case 'replied':
      big = tSla('replied');
      spoken = tSla('repliedLabel');
      break;
    case 'paused':
      big = tSla('paused');
      spoken = tSla('pausedLabel');
      break;
    case 'done':
      big = tStatus(model.value.status);
      spoken = big;
      break;
  }

  const target = formatWindow(ticket.sla.resolveMins, ticket.sla.businessHoursOnly);
  const resolution = model.resolution;

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border border-track bg-surface-muted p-4',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Kicker as="h3" id={titleId}>
          {t(model.kicker)}
        </Kicker>
        <Kicker as="span" className="whitespace-nowrap">
          {formatWindow(ticket.sla.firstReplyMins, ticket.sla.businessHoursOnly)}
        </Kicker>
      </div>
      <p
        data-sla={model.tone}
        className={cn(
          'text-[28px] leading-none font-semibold transition-colors duration-200 ease-out',
          model.tone === 'done' ? 'text-ink-muted' : SLA_TONE_TEXT[model.tone],
        )}
      >
        <span aria-hidden="true">{big}</span>
        <span className="sr-only">{spoken}</span>
      </p>
      <div className="h-1 overflow-hidden rounded-[2px] bg-track" aria-hidden="true">
        <div
          className={cn(
            'h-full transition-[width,background-color] duration-200 ease-out',
            SLA_TONE_BAR[model.tone],
          )}
          style={{ width: `${model.percent}%` }}
        />
      </div>
      <p className="text-[13px] text-ink-secondary">
        {t('resolutionTarget', { window: target })}
        {model.resolutionPaused ? (
          <span className="text-status-pending-fg">
            {' · '}
            {t('resolutionPaused')}
          </span>
        ) : null}
        {resolution ? (
          <span className={resolution.overdue ? 'text-danger' : undefined}>
            {' · '}
            {resolution.overdue
              ? t('resolutionOverdue', {
                  duration: formatDuration(-resolution.remainingMs, locale),
                })
              : t('resolutionLeft', { duration: formatDuration(resolution.remainingMs, locale) })}
          </span>
        ) : null}
      </p>
    </section>
  );
}
