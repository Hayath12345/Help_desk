'use client';

import { ArrowLeft } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { PriorityLabel } from '@/components/common/priority';
import { localizedLabel, placeName } from '@/lib/tickets/labels';
import type { AnyTicketDto } from '@/lib/tickets/types';
import { cn } from '@/lib/utils';

export interface ConversationHeaderProps {
  ticket: AnyTicketDto;
  /** "← Back to list" (single-pane layout below 860 px). */
  onBack?: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
  headingId?: string;
  className?: string;
}

/**
 * Conversation header (design 772–780): back link on phones, the mono line
 * `LG-4817 · Category › Sub-type · via portal · Site`, then the subject and its priority.
 */
export function ConversationHeader({
  ticket,
  onBack,
  headingRef,
  headingId,
  className,
}: ConversationHeaderProps) {
  const t = useTranslations('console.ticket');
  const tChannel = useTranslations('tickets.channel');
  const locale = useLocale();
  const categoryPath = ticket.subtype
    ? `${localizedLabel(ticket.category, locale)} › ${localizedLabel(ticket.subtype, locale)}`
    : localizedLabel(ticket.category, locale);

  return (
    <header
      className={cn(
        'flex shrink-0 flex-col gap-1.5 border-b border-line px-[26px] py-[18px]',
        className,
      )}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-1.5 self-start pb-1 text-ink-muted transition-colors hover:text-ink min-[860px]:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4 rtl:-scale-x-100" />
          {t('backToList')}
        </button>
      ) : null}
      <p className="font-mono text-xs leading-normal text-ink-muted">
        <bdi dir="ltr">{ticket.ref}</bdi>
        {' · '}
        {categoryPath}
        {' · '}
        {t('via', { channel: tChannel(ticket.channel) })}
        {ticket.site ? (
          <>
            {' · '}
            {placeName(ticket.site, locale)}
          </>
        ) : null}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 text-[21px] leading-[1.3] font-semibold text-pretty text-ink outline-none"
        >
          {/* Isolated: an English subject keeps its punctuation in place inside the Arabic UI. */}
          <bdi>{ticket.subject}</bdi>
        </h2>
        <PriorityLabel priority={ticket.priority} />
      </div>
    </header>
  );
}
