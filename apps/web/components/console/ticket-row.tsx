'use client';

import type { TicketSummaryDto } from '@loons/shared';
import { motion } from 'motion/react';
import { useLocale, useTranslations } from 'next-intl';
import { InitialsAvatar } from '@/components/common/initials-avatar';
import { PriorityDot } from '@/components/common/priority';
import { StatusPill } from '@/components/common/status-pill';
import { TicketId } from '@/components/common/ticket-id';
import { SlaText } from '@/components/tickets/sla-text';
import { initialsFrom } from '@/lib/format';
import { listItemVariants, transitions } from '@/lib/motion';
import { placeName } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';

export interface TicketRowProps {
  ticket: TicketSummaryDto;
  href: string;
  selected: boolean;
  /** Shared clock (ms) so every row's SLA text agrees. */
  now: number;
  onSelect: (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** Hover / focus: warm the detail and thread caches. */
  onPrefetch?: (ticket: TicketSummaryDto) => void;
}

/**
 * Inbox row (design 745–758): priority dot, "requester · client", SLA countdown; the subject;
 * `LG-n`, the status pill and the assignee's initials. A link (`?ticket=LG-n`), so it can be
 * opened in a new tab; a plain click selects it without reloading. Rows animate in / out and
 * slide to their new place when the order changes.
 */
export function TicketRow({ ticket, href, selected, now, onSelect, onPrefetch }: TicketRowProps) {
  const t = useTranslations('console.inbox');
  const locale = useLocale();
  const assignee = ticket.assignee;

  return (
    <motion.li
      layout="position"
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ layout: transitions.layout }}
    >
      <a
        href={href}
        data-ticket-ref={ticket.ref}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => onSelect(ticket, event)}
        onPointerEnter={() => onPrefetch?.(ticket)}
        onFocus={() => onPrefetch?.(ticket)}
        className={cn(
          'flex w-full flex-col gap-1.5 border-b border-s-[3px] border-divider py-3.5 ps-[17px] pe-[18px] text-start text-ink no-underline transition-colors duration-150 ease-out outline-none hover:text-ink focus-visible:bg-surface-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
          selected
            ? 'border-s-brand bg-brand-wash hover:bg-brand-wash'
            : 'border-s-transparent bg-surface hover:bg-surface-muted',
        )}
      >
        <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-secondary">
          <PriorityDot priority={ticket.priority} />
          <span className="min-w-0 flex-1 truncate">
            {t('requesterOrg', {
              requester: ticket.requester.name,
              org: placeName(ticket.org, locale),
            })}
          </span>
          {/* ink-muted is 4.35:1 on the selected row's brand wash: the done text goes darker. */}
          <SlaText
            ticket={ticket}
            now={now}
            className={selected ? 'data-[sla=done]:text-ink-secondary' : undefined}
          />
        </span>
        <span className="text-[15px] leading-[1.3] font-medium">
          <bdi>{ticket.subject}</bdi>
        </span>
        <span className="flex items-center gap-2">
          <TicketId
            number={ticket.number}
            className={selected ? 'text-ink-secondary' : undefined}
          />
          <StatusPill status={ticket.status} />
          <span className="flex-1" />
          {assignee ? (
            <InitialsAvatar
              initials={initialsFrom(assignee.name) || '?'}
              name={t('assignedTo', { name: assignee.name })}
              variant="track"
              size="xs"
            />
          ) : (
            <span
              role="img"
              aria-label={t('unassigned')}
              title={t('unassigned')}
              className="inline-grid size-[22px] shrink-0 place-items-center rounded-full bg-track text-[9px] font-semibold text-ink-secondary"
            >
              <span aria-hidden="true">—</span>
            </span>
          )}
        </span>
      </a>
    </motion.li>
  );
}
