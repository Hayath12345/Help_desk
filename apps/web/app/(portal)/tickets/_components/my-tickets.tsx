'use client';

import { MAX_TICKET_ROOMS_PER_SOCKET, type TicketSummaryDto } from '@loons/shared';
import { AnimatePresence, motion } from 'motion/react';
import type { Route } from 'next';
import Link from 'next/link';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { PageHeader } from '@/components/common/page-header';
import { LoadingRegion, PortalTicketRowSkeleton } from '@/components/common/skeletons';
import { StatusPill } from '@/components/common/status-pill';
import { TicketId } from '@/components/common/ticket-id';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { listItemVariants, transitions } from '@/lib/motion';
import { useTicketRooms } from '@/lib/realtime/hooks';
import { localizedLabel } from '@/lib/tickets/labels';
import { useTicketCounts, useTickets } from '@/lib/tickets/queries';
import {
  TICKET_TABS,
  isTicketTab,
  matchesTab,
  portalListFilters,
  portalTicketHref,
  sortByRecent,
  type TicketTab,
} from './types';
import { usePortalListSync, usePrefetchTicket } from './use-portal-sync';

/**
 * Rows whose ticket rooms are joined for live updates (status, preview, new activity). Kept well
 * below the server's per-socket rooms cap, so the tab's other rooms (an open ticket's thread) and
 * rooms still being left after the rows changed never push a join over it.
 */
export const MAX_LIVE_ROWS = MAX_TICKET_ROOMS_PER_SOCKET - 10;

export interface MyTicketsProps {
  firstName: string;
  initialTab: TicketTab;
}

/**
 * "My tickets" (design 578–605): header + All / Active / Solved underline tabs with counts + the
 * white list card. Each tab is a server list (`scope=mine`, newest activity first) kept live by
 * the rows' ticket rooms (ticket:updated) and a periodic refresh; rows animate in, out and into
 * their new place when a reply or a status change moves them.
 */
export function MyTickets({ firstName, initialTab }: MyTicketsProps) {
  const t = useTranslations('portal.tickets');
  const locale = useLocale();
  const [tab, setTab] = useState<TicketTab>(initialTab);

  // keepPrevious: while another tab loads, the previous rows stay (filtered to the new tab) so the
  // switch animates instead of flashing skeletons.
  const list = useTickets(portalListFilters(tab), { keepPrevious: true });
  const counts = useTicketCounts();
  usePortalListSync();

  const items = list.data?.items;
  // The API filters by tab; filtering again keeps a row that an optimistic or realtime status
  // change just moved out of this tab from lingering until the next refetch.
  const visible = useMemo(
    () => (items ? sortByRecent(items.filter((ticket) => matchesTab(ticket, tab))) : []),
    [items, tab],
  );
  const liveIds = useMemo(() => visible.slice(0, MAX_LIVE_ROWS).map((tk) => tk.id), [visible]);
  useTicketRooms(liveIds);

  const tabCounts = counts.data?.kind === 'client' ? counts.data.tabs : null;
  const showSkeleton = list.isPending || (list.isPlaceholderData && visible.length === 0);
  const failed = list.isError && !items;

  const onTabChange = (value: string) => {
    if (!isTicketTab(value)) return;
    setTab(value);
    // Keep the filter in the URL (shareable, survives reload) without a server round trip.
    const url = new URL(window.location.href);
    if (value === 'all') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', url);
  };

  return (
    <Tabs value={tab} onValueChange={onTabChange} className="gap-[18px]">
      <PageHeader
        title={t('title')}
        description={t('greeting', { name: firstName })}
        actions={
          <TabsList variant="line" aria-label={t('tabsLabel')}>
            {TICKET_TABS.map((key) => (
              <TabsTrigger key={key} value={key}>
                {t(`tabs.${key}`)}
                <span className="text-xs font-normal text-ink-muted tabular-nums">
                  {tabCounts ? formatNumber(tabCounts[key], locale) : '–'}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        }
      />
      {/* One panel whose value follows the active tab, so rows animate between filters. */}
      <TabsContent value={tab} className="mt-0 rounded-xl">
        <Card className="gap-0 py-0">
          {showSkeleton ? (
            <LoadingRegion label={t('loading')}>
              {Array.from({ length: 4 }, (_, i) => (
                <PortalTicketRowSkeleton key={i} index={i} />
              ))}
            </LoadingRegion>
          ) : failed ? (
            <div role="alert">
              <EmptyState
                title={t('loadFailed')}
                action={
                  <Button type="button" variant="outline" onClick={() => void list.refetch()}>
                    {t('retry')}
                  </Button>
                }
              />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              action={<NewTicketButton />}
            />
          ) : (
            <>
              <TicketList tickets={visible} label={t('listLabel')} />
              {list.hasNextPage && !list.isPlaceholderData ? (
                <LoadMore
                  loading={list.isFetchingNextPage}
                  onLoadMore={() => void list.fetchNextPage()}
                />
              ) : null}
            </>
          )}
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function LoadMore({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  const t = useTranslations('portal.tickets');
  return (
    <div className="flex flex-col border-t border-divider">
      {loading ? (
        <LoadingRegion label={t('loadingMore')}>
          <PortalTicketRowSkeleton index={0} />
        </LoadingRegion>
      ) : null}
      <div className="flex justify-center px-5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={loading || undefined}
          onClick={() => {
            if (!loading) onLoadMore();
          }}
        >
          {t('loadMore')}
        </Button>
      </div>
    </div>
  );
}

function TicketList({ tickets, label }: { tickets: readonly TicketSummaryDto[]; label: string }) {
  const locale = useLocale();
  const now = useNow({ updateInterval: 60_000 });
  const prefetch = usePrefetchTicket();

  return (
    <motion.ul aria-label={label} layout transition={{ layout: transitions.layout }}>
      <AnimatePresence initial={false} mode="popLayout">
        {tickets.map((ticket) => (
          <motion.li
            key={ticket.id}
            layout
            variants={listItemVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ layout: transitions.layout }}
            className="border-b border-divider bg-surface last:border-b-0"
          >
            <Link
              href={portalTicketHref(ticket) as Route}
              onPointerEnter={() => prefetch(ticket)}
              onFocus={() => prefetch(ticket)}
              // The Card clips overflow, so the global outline would lose its sides: an inset
              // ring (like the console rows) stays fully visible on every row. Forced colours drop
              // the ring: outline-hidden's system-colour outline, inset too, marks the focus there.
              className="flex items-center gap-4 px-5 py-4 text-ink no-underline outline-none transition-colors duration-150 hover:bg-surface-muted hover:text-ink focus-visible:bg-surface-muted focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {/* Subjects/previews are typed in either language: <bdi> isolates their direction
                    while the column keeps the page's alignment. */}
                <span className="text-[15px] font-medium">
                  <bdi>{ticket.subject}</bdi>
                </span>
                <span className="flex min-w-0 items-center gap-2 text-[13px] text-ink-muted">
                  <span className="text-xs whitespace-nowrap">
                    <TicketId number={ticket.number} />
                    <span className="font-mono rtl:font-sans">
                      {' · '}
                      {localizedLabel(ticket.category, locale)}
                    </span>
                  </span>
                  {ticket.preview ? (
                    // dir="auto" on the truncating box itself: an English preview in the Arabic
                    // UI (or vice versa) is cut at its own end, not at its first words.
                    <span dir="auto" className="truncate">
                      {ticket.preview}
                    </span>
                  ) : null}
                </span>
              </span>
              <StatusPill status={ticket.status} />
              <span
                className="w-24 shrink-0 text-end font-mono text-xs whitespace-nowrap text-ink-muted max-sm:hidden rtl:font-sans"
                suppressHydrationWarning
              >
                <time dateTime={ticket.updatedAt}>
                  {formatRelativeTime(ticket.updatedAt, locale, now.getTime())}
                </time>
              </span>
            </Link>
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
