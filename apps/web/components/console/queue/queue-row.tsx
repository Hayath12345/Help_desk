'use client';

import { slaState, type SlaFields, type TicketSummaryDto } from '@loons/shared';
import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { PriorityPill } from '@/components/common/priority';
import { StatusPill } from '@/components/common/status-pill';
import { TicketId } from '@/components/common/ticket-id';
import {
  SLA_TONE_BAR,
  SlaText,
  rowResolutionClock,
  slaRowTone,
  type SlaTone,
} from '@/components/tickets/sla-text';
import { Checkbox } from '@/components/ui/checkbox';
import { listItemVariants, transitions } from '@/lib/motion';
import { queueTicketHref } from '@/lib/queue/url';
import { localizedLabel, placeName } from '@/lib/tickets/labels';
import { TRUNCATE_ANY_DIRECTION, cn } from '@/lib/utils';
import { QUEUE_GRID, QUEUE_ROW } from './layout';

/**
 * The "First reply SLA" bar (design `sla()` 1482–1489) for the state the row's text shows
 * (`SlaText` / `slaRowTone`): the remaining share of the running window (at least 4%, as on the
 * SLA card) while it counts down — the first-reply clock, or the resolution clock the row shows
 * once it is at risk or overdue — and a full bar otherwise (overdue red, replied green, paused,
 * solved grey).
 */
export function queueSlaBar(ticket: SlaFields, now: number): { tone: SlaTone; percent: number } {
  const state = slaState(ticket, now);
  const tone = slaRowTone(state);
  const clock =
    state.kind === 'firstReply'
      ? state.clock
      : state.kind === 'replied'
        ? rowResolutionClock(state)
        : null;
  const percent =
    !clock || clock.overdue
      ? 100
      : Math.max(4, Math.min(100, (clock.remainingMs / clock.windowMs) * 100));
  return { tone, percent };
}

export interface QueueRowProps {
  ticket: TicketSummaryDto;
  /** Shared clock (ms) so every row's SLA agrees. */
  now: number;
  selected: boolean;
  onSelectedChange: (ticket: TicketSummaryDto, selected: boolean) => void;
  /** The row's link was activated (click / Enter); plain clicks open the ticket in place. */
  onOpen: (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Queue table row (design 947–955): checkbox · priority pill · subject + "LG-4771 · Category" ·
 * requester + organisation · first-reply SLA text + 3px bar · assignee · round status pill. The
 * subject is a link to the ticket in the Inbox whose overlay covers the row (click anywhere, open
 * in a new tab, Enter when focused); the checkbox sits above the overlay, so selecting never
 * opens the ticket. Phones get a stacked card. Rows fade in / out and slide to new places.
 */
export function QueueRow({ ticket, now, selected, onSelectedChange, onOpen }: QueueRowProps) {
  const t = useTranslations('console.queue');
  const locale = useLocale();
  const { tone, percent } = queueSlaBar(ticket, now);

  return (
    <motion.div
      role="row"
      layout="position"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ layout: transitions.layout }}
      data-selected={selected || undefined}
      data-ticket-id={ticket.id}
      className={cn(
        QUEUE_ROW,
        QUEUE_GRID,
        'transition-colors duration-150 ease-out',
        selected ? 'bg-brand-wash-subtle' : 'bg-surface hover:bg-surface-muted',
        'has-[[data-row-open]:focus-visible]:outline-hidden has-[[data-row-open]:focus-visible]:ring-2 has-[[data-row-open]:focus-visible]:ring-brand has-[[data-row-open]:focus-visible]:ring-inset forced-colors:has-[[data-row-open]:focus-visible]:-outline-offset-2',
      )}
    >
      <div role="cell" className="relative z-10 flex items-center">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(ticket, checked === true)}
          aria-label={t('selectRow', { ref: ticket.ref })}
        />
      </div>
      <div role="cell" className="flex items-center">
        <PriorityPill priority={ticket.priority} />
      </div>
      <div
        role="cell"
        className="order-4 flex w-full min-w-0 flex-col gap-0.5 md:order-none md:w-auto"
      >
        <a
          href={queueTicketHref(ticket)}
          data-row-open=""
          data-ticket-ref={ticket.ref}
          dir="auto"
          onClick={(event) => onOpen(ticket, event)}
          className={cn(
            'block text-[15px] font-medium text-ink no-underline outline-none after:absolute after:inset-0 hover:text-ink focus-visible:outline-hidden',
            TRUNCATE_ANY_DIRECTION,
          )}
        >
          {ticket.subject}
        </a>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-ink-muted">
          <TicketId number={ticket.number} />
          <span aria-hidden="true">·</span>
          <span dir="auto" className={TRUNCATE_ANY_DIRECTION}>
            {localizedLabel(ticket.category, locale)}
          </span>
        </span>
      </div>
      <div
        role="cell"
        className="order-5 flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 md:order-none md:w-auto md:flex-col md:flex-nowrap md:items-stretch md:gap-0.5"
      >
        <span dir="auto" className={cn('text-sm text-ink', TRUNCATE_ANY_DIRECTION)}>
          {ticket.requester.name}
        </span>
        <span aria-hidden="true" className="text-ink-muted md:hidden">
          ·
        </span>
        <span dir="auto" className={cn('text-[13px] text-ink-muted', TRUNCATE_ANY_DIRECTION)}>
          {placeName(ticket.org, locale)}
        </span>
      </div>
      <div role="cell" className="order-6 flex min-w-0 flex-1 flex-col gap-[5px] md:order-none">
        <SlaText ticket={ticket} now={now} className="text-[13px]" />
        <span aria-hidden="true" className="block h-[3px] overflow-hidden rounded-[2px] bg-track">
          <span
            data-sla-bar={tone}
            className={cn(
              'block h-full transition-[width,background-color] duration-200 ease-out',
              SLA_TONE_BAR[tone],
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
      </div>
      <div
        role="cell"
        className="order-7 flex max-w-[45%] min-w-0 text-sm text-ink-secondary md:order-none md:max-w-none"
      >
        {ticket.assignee ? (
          <span dir="auto" className={cn('min-w-0', TRUNCATE_ANY_DIRECTION)}>
            {ticket.assignee.name}
          </span>
        ) : (
          <span className="truncate">{t('assigneeNone')}</span>
        )}
      </div>
      <div role="cell" className="order-3 ms-auto flex items-center md:order-none md:ms-0">
        <StatusPill status={ticket.status} shape="round" />
      </div>
    </motion.div>
  );
}
