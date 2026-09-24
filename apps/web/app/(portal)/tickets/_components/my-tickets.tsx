'use client';

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
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatRelativeTime } from '@/lib/format';
import { listItemVariants, transitions } from '@/lib/motion';
import {
  TICKET_TABS,
  isTicketTab,
  matchesTab,
  type PortalTicketSummary,
  type TicketTab,
} from './types';

export interface MyTicketsProps {
  firstName: string;
  initialTab: TicketTab;
  tickets: readonly PortalTicketSummary[];
  /** True while the list is being fetched (renders skeleton rows). */
  isLoading?: boolean;
}

/** "My tickets" (design 578–605): header + All/Active/Solved underline tabs + white list card. */
export function MyTickets({ firstName, initialTab, tickets, isLoading = false }: MyTicketsProps) {
  const t = useTranslations('portal.tickets');
  const [tab, setTab] = useState<TicketTab>(initialTab);

  const counts = useMemo(
    () =>
      Object.fromEntries(TICKET_TABS.map((key) => [key, tickets.filter((tk) => matchesTab(tk, key)).length])) as Record<
        TicketTab,
        number
      >,
    [tickets],
  );
  const visible = useMemo(() => tickets.filter((tk) => matchesTab(tk, tab)), [tickets, tab]);

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
                  {isLoading ? '–' : counts[key]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        }
      />
      {/* One panel whose value follows the active tab, so rows animate between filters. */}
      <TabsContent value={tab} className="mt-0 rounded-xl">
        <Card className="gap-0 py-0">
          {isLoading ? (
            <LoadingRegion label={t('loading')}>
              {Array.from({ length: 4 }, (_, i) => (
                <PortalTicketRowSkeleton key={i} index={i} />
              ))}
            </LoadingRegion>
          ) : visible.length === 0 ? (
            <EmptyState
              title={t('emptyTitle')}
              description={t('emptyDescription')}
              action={<NewTicketButton />}
            />
          ) : (
            <TicketList tickets={visible} />
          )}
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function TicketList({ tickets }: { tickets: readonly PortalTicketSummary[] }) {
  const locale = useLocale();
  const now = useNow({ updateInterval: 60_000 });

  return (
    <motion.ul layout transition={{ layout: transitions.layout }}>
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
              href={`/tickets/${ticket.number}` as Route}
              className="flex items-center gap-4 px-5 py-4 text-ink no-underline transition-colors duration-150 hover:bg-surface-muted hover:text-ink"
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
                    <span className="font-mono rtl:font-sans"> · {ticket.category}</span>
                  </span>
                  <span className="truncate">
                    <bdi>{ticket.preview}</bdi>
                  </span>
                </span>
              </span>
              <StatusPill status={ticket.status} />
              <span
                className="w-24 shrink-0 text-end font-mono text-xs whitespace-nowrap text-ink-muted max-sm:hidden rtl:font-sans"
                suppressHydrationWarning
              >
                {formatRelativeTime(ticket.updatedAt, locale, now.getTime())}
              </span>
            </Link>
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
