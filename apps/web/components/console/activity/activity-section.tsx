'use client';

import type { Locale, TicketEventDto, TicketEventType } from '@loons/shared';
import { ChevronDown } from 'lucide-react';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Kicker } from '@/components/common/kicker';
import { LoadingRegion, SkeletonText, lineWidth } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { useViewer, isStaffViewer } from '@/lib/tickets/viewer';
import { cn } from '@/lib/utils';
import { useActivityText } from './event-text';
import { useTicketEvents } from './use-ticket-events';

/** Decorative dot per event (the sentence says the same in words). */
const DOT_TONE: Partial<Record<TicketEventType, string>> = {
  CREATED: 'bg-brand',
  FIRST_REPLY: 'bg-brand',
  SLA_AT_RISK: 'bg-warning',
  SLA_BREACHED: 'bg-danger',
  ESCALATED: 'bg-danger',
  P1_ACKNOWLEDGED: 'bg-success-strong',
};

/**
 * Staff-only "Activity" section of the console ticket panel (docs/PHASE5_CONTRACT.md F14): the
 * ticket's events (GET /tickets/:id/events) newest first — what changed, who did it (or
 * "System") and when (relative, the absolute time in the tooltip) — with "Show older activity"
 * paging. Collapsed until the agent opens it; opening it (re)loads the events, and while it is
 * open a `ticket:updated` for the ticket refetches them (debounced). Never rendered for clients.
 */
export function ActivitySection({ ticketId }: { ticketId: string }) {
  const t = useTranslations('console.activity');
  const viewer = useViewer();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const panelId = useId();

  if (!isStaffViewer(viewer)) return null;

  return (
    <section
      aria-labelledby={headingId}
      data-activity=""
      className="flex flex-col gap-3 border-t border-divider pt-5"
    >
      <h3 id={headingId} className="flex">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="-mx-1 -my-0.5 flex flex-1 cursor-pointer items-center justify-between gap-2 rounded-sm px-1 py-0.5 text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-hidden"
        >
          <Kicker as="span">{t('title')}</Kicker>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </button>
      </h3>
      <div id={panelId} hidden={!open}>
        {open ? <ActivityList ticketId={ticketId} /> : null}
      </div>
    </section>
  );
}

function ActivityList({ ticketId }: { ticketId: string }) {
  const t = useTranslations('console.activity');
  const query = useTicketEvents(ticketId);
  const text = useActivityText();
  const now = useNow({ updateInterval: 30_000 }).getTime();
  const list = useRef<HTMLOListElement>(null);
  // "Show older activity" pressed with the focus on it: the focus continues on the first older
  // event once it has loaded (the button may be gone after the last page).
  const focusFrom = useRef<number | null>(null);
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);

  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || items.length <= from) return;
    focusFrom.current = null;
    list.current?.querySelectorAll<HTMLElement>('[data-event]')[from]?.focus();
  }, [items.length]);

  if (query.isPending) {
    return (
      <LoadingRegion label={t('loading')} className="flex flex-col gap-3.5">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5 ps-[18px]">
            <SkeletonText className={lineWidth(i)} />
            <SkeletonText className="h-2.5 w-24" />
          </div>
        ))}
      </LoadingRegion>
    );
  }

  if (items.length === 0) {
    return query.isError ? (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[13px] text-ink-secondary">{t('loadFailed')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={query.isFetching || undefined}
          onClick={() => {
            if (!query.isFetching) void query.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    ) : (
      <p className="text-[13px] text-ink-muted">{t('empty')}</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ol ref={list} aria-label={t('listLabel')} className="flex flex-col">
        {items.map((event) => (
          <ActivityItem key={event.id} event={event} text={text} now={now} />
        ))}
      </ol>
      {query.isFetchNextPageError ? (
        <p role="alert" className="text-[13px] text-danger">
          {t('loadMoreFailed')}
        </p>
      ) : null}
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-brand-ink"
          aria-disabled={query.isFetchingNextPage || undefined}
          onClick={(event) => {
            if (query.isFetchingNextPage) return;
            if (document.activeElement === event.currentTarget) focusFrom.current = items.length;
            void query.fetchNextPage();
          }}
        >
          {query.isFetchingNextPage ? t('loadingMore') : t('showMore')}
        </Button>
      ) : null}
    </div>
  );
}

function ActivityItem({
  event,
  text,
  now,
}: {
  event: TicketEventDto;
  text: ReturnType<typeof useActivityText>;
  now: number;
}) {
  const locale = useLocale() as Locale;
  return (
    <li
      data-event={event.type}
      tabIndex={-1}
      className={cn(
        'relative flex gap-2.5 pb-3 last:pb-0',
        // The rail between the dots.
        'before:absolute before:start-[3px] before:top-3.5 before:bottom-0 before:w-px before:bg-divider last:before:hidden',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-[5px] size-2 shrink-0 rounded-full forced-colors:bg-[CanvasText]',
          DOT_TONE[event.type] ?? 'bg-ink-subtle',
        )}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-[13px] leading-[1.45] text-ink [overflow-wrap:anywhere]">
          {text.describe(event)}
        </p>
        <p className="text-xs text-ink-muted">
          <bdi>{text.who(event)}</bdi>
          {' · '}
          <time dateTime={event.createdAt} title={formatDateTime(event.createdAt, locale)}>
            {formatRelativeTime(event.createdAt, locale, now)}
          </time>
        </p>
      </div>
    </li>
  );
}
