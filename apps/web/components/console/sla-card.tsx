'use client';

import {
  slaState,
  type SlaClock,
  type SlaFields,
  type SlaState,
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
  /**
   * Per target (D1/D16): `atRisk` once its stored at-risk instant has passed while it runs;
   * `breached` once its due date passed before the target was met (first reply sent / solved /
   * paused) — this stays after the target is met, e.g. a late first reply.
   */
  firstReplyFlag: SlaTargetFlag;
  resolutionFlag: SlaTargetFlag;
  /**
   * The API's sticky `slaBreached` flag with no breach the stored dates still show (e.g. a
   * priority change moved the due dates after a breach): said on the target line.
   */
  breachedEarlier: boolean;
}

export type SlaTargetFlag = 'atRisk' | 'breached' | null;

/** The SLA fields plus `solvedAt` (when the resolution target was met). */
export type SlaCardFields = SlaFields & { solvedAt?: string | Date | null };

const ms = (value: string | Date | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isNaN(n) ? null : n;
};

/** Due date passed before `end` (when the target was met or its clock stopped; else now). */
function breachedBy(due: number | null, end: number | null, now: number): boolean {
  return due !== null && (end ?? now) > due;
}

function targetFlags(
  ticket: SlaCardFields,
  state: SlaState,
  now: number,
): Pick<SlaCardModel, 'firstReplyFlag' | 'resolutionFlag' | 'breachedEarlier'> {
  const solvedAt = ms(ticket.solvedAt);
  const firstBreached = breachedBy(
    ms(ticket.firstReplyDueAt),
    ms(ticket.firstRepliedAt) ?? solvedAt,
    now,
  );
  // The resolution clock stops when the ticket is solved, and while it is PENDING (from
  // slaPausedAt: the API moves the due date when the pause ends).
  const resolutionBreached = breachedBy(
    ms(ticket.resolveDueAt),
    solvedAt ?? ms(ticket.slaPausedAt),
    now,
  );
  const firstAtRisk = state.kind === 'firstReply' && state.clock.atRisk;
  const resolution =
    state.kind === 'firstReply' || state.kind === 'replied' ? state.resolution : null;
  return {
    firstReplyFlag: firstBreached ? 'breached' : firstAtRisk ? 'atRisk' : null,
    resolutionFlag: resolutionBreached ? 'breached' : resolution?.atRisk ? 'atRisk' : null,
    breachedEarlier: ticket.slaBreached && !firstBreached && !resolutionBreached,
  };
}

/** What the SLA card shows for a ticket at `now` (design `sla()` + the right-panel card). */
export function slaCardModel(ticket: SlaCardFields, now: number): SlaCardModel {
  const state = slaState(ticket, now);
  const tone = slaTone(state);
  const flags = targetFlags(ticket, state, now);
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
        ...flags,
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
        ...flags,
      };
    case 'paused':
      return {
        kicker: 'firstReply',
        tone,
        value: { kind: 'paused' },
        percent: 100,
        resolution: null,
        resolutionPaused: true,
        ...flags,
      };
    case 'done':
      return {
        kicker: 'firstReply',
        tone,
        value: { kind: 'done', status: ticket.status },
        percent: 100,
        resolution: null,
        resolutionPaused: false,
        ...flags,
      };
  }
}

const FLAG_PILL: Record<'atRisk' | 'breached', string> = {
  atRisk: 'bg-p2-bg text-p2-fg',
  breached: 'bg-danger-tint text-danger',
};

/**
 * Right-panel SLA card (design 815–820): kicker + policy window, the big countdown coloured by
 * the SLA state, the progress bar and the resolution target. Each target also says when it is at
 * risk or breached (D16): a pill beside the first-reply value, words on the resolution line.
 * Ticks every 15 s.
 */
export function SlaCard({
  ticket,
  className,
}: {
  ticket: Pick<TicketDetailDto, keyof SlaFields | 'solvedAt' | 'sla'>;
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
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
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
        {model.firstReplyFlag ? (
          <span
            data-sla-flag={model.firstReplyFlag}
            className={cn(
              'rounded-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap',
              FLAG_PILL[model.firstReplyFlag],
            )}
          >
            {t(model.firstReplyFlag)}
          </span>
        ) : null}
      </div>
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
          <span
            data-sla-resolution={resolution.overdue ? 'overdue' : resolution.atRisk ? 'risk' : 'ok'}
            className={
              resolution.overdue ? 'text-danger' : resolution.atRisk ? 'text-p2-fg' : undefined
            }
          >
            {' · '}
            {resolution.overdue
              ? t('resolutionOverdue', {
                  duration: formatDuration(-resolution.remainingMs, locale),
                })
              : t('resolutionLeft', { duration: formatDuration(resolution.remainingMs, locale) })}
            {resolution.atRisk ? ` · ${t('resolutionAtRisk')}` : null}
          </span>
        ) : null}
        {/* Unanswered tickets show no resolution countdown: still say when it is at risk. */}
        {model.resolutionFlag === 'atRisk' && !resolution ? (
          <span data-sla-resolution="risk" className="text-p2-fg">
            {' · '}
            {t('resolutionAtRisk')}
          </span>
        ) : null}
        {/* A breach the running countdown doesn't show already (paused, solved). */}
        {model.resolutionFlag === 'breached' && !resolution?.overdue ? (
          <span data-sla-resolution="breached" className="text-danger">
            {' · '}
            {t('resolutionBreached')}
          </span>
        ) : null}
        {model.breachedEarlier ? (
          <span data-sla-resolution="breached-earlier" className="text-danger">
            {' · '}
            {t('breachedEarlier')}
          </span>
        ) : null}
      </p>
    </section>
  );
}
