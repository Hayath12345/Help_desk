'use client';

import type { StaffView, TicketSort, TicketSummaryDto } from '@loons/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useCustomerOrg } from '@/lib/customers/queries';
import { fetchTicket } from '@/lib/tickets/api';
import { ticketKeys } from '@/lib/tickets/keys';
import { placeName, teamName } from '@/lib/tickets/labels';
import { loadThread, useTicketCounts, useTickets } from '@/lib/tickets/queries';
import { cn } from '@/lib/utils';
import { CompanyFilter } from './company-filter';
import { focusInboxList } from './inbox-focus';
import { ConversationPane } from './conversation';
import {
  inboxHref,
  isSelectedTicket,
  isTicketSort,
  listFiltersFor,
  updateInboxUrl,
  useInboxState,
} from './inbox-url';
import { TicketList } from './ticket-list';
import { ViewSelect, ViewsSidebar, isPlainClick } from './views-sidebar';

/** Per-agent preference (browser only): the list's sort order. */
export const INBOX_SORT_KEY = 'loons.console.inbox.sort';
/** "SLA at risk" membership and the countdowns change with time, not only with events. */
const TIME_REFRESH_MS = 60_000;
/** Hover intent before warming a ticket's caches. */
const PREFETCH_DELAY_MS = 150;

const EMPTY: TicketSummaryDto[] = [];

type Target = { view: StaffView } | { teamId: string };

/**
 * Agent inbox (design 707–890, docs/PHASE2_CONTRACT.md → Agent console): Views + Teams with live
 * counts, the ticket list (SLA order or most recent), and the selected ticket's conversation and
 * properties; `?org=` lists one company's tickets (Phase 5 F9, from Customers or the requester
 * card). All state lives in the URL (`?view=&team=&org=&ticket=&q=`) and changes through the
 * History API, so selecting a ticket never reloads the page. Layout as in the design: three
 * columns from 1180 px, the Views column becomes a select below that, and below 860 px only the
 * list or the conversation shows.
 */
export function Inbox() {
  const t = useTranslations('console.inbox');
  const locale = useLocale();
  const queryClient = useQueryClient();
  const state = useInboxState();
  const [sort, setSort] = useLocalStorageState<TicketSort>(INBOX_SORT_KEY, 'sla', isTicketSort);
  const counts = useTicketCounts();
  const staffCounts = counts.data?.kind === 'staff' ? counts.data : undefined;
  // Company view (Phase 5 F9): its title comes from the organisation, also from a shared URL.
  const company = useCustomerOrg(state.orgId);
  const list = useTickets(listFiltersFor(state, sort), { keepPrevious: true });
  const items = list.data?.items ?? EMPTY;
  const wide = useMediaQuery('(min-width: 860px)');
  // Single pane: the conversation was opened from the list (Back = history back).
  const openedFromList = useRef(false);
  const returnFocusTo = useRef<string | null>(null);
  const [focusRef, setFocusRef] = useState<string | null>(null);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Time-based changes (SLA at risk, countdown order): refresh while the tab is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
      void queryClient.invalidateQueries({ queryKey: ticketKeys.lists() });
    }, TIME_REFRESH_MS);
    return () => clearInterval(timer);
  }, [queryClient]);

  useEffect(
    () => () => {
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    },
    [],
  );

  // Two- and three-pane layouts always show a conversation: the first ticket when none is chosen.
  const firstRef = items[0]?.ref ?? null;
  const settled = list.isSuccess && !list.isPlaceholderData;
  useEffect(() => {
    if (wide && settled && !state.ticket && firstRef) {
      updateInboxUrl({ ticket: firstRef }, 'replace');
    }
  }, [wide, settled, state.ticket, firstRef]);

  // Back to the list (single pane): focus returns to the row that was open.
  useEffect(() => {
    const ref = returnFocusTo.current;
    if (state.ticket || !ref) return;
    returnFocusTo.current = null;
    // Refs are "LG-4817" or uuids; anything else is dropped rather than escaped.
    const safe = ref.replace(/[^\w-]/g, '');
    document.querySelector<HTMLElement>(`[data-ticket-ref="${safe}"]`)?.focus();
  }, [state.ticket]);

  const selectTicket = (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    if (!wide) {
      openedFromList.current = true;
      setFocusRef(ticket.ref);
    }
    updateInboxUrl({ ticket: ticket.ref }, wide ? 'replace' : 'push');
  };

  const backToList = () => {
    returnFocusTo.current = state.ticket;
    if (openedFromList.current) {
      openedFromList.current = false;
      window.history.back();
    } else {
      updateInboxUrl({ ticket: null }, 'replace');
    }
  };

  // A view or a team replaces the company view.
  const patchFor = (target: Target) =>
    'teamId' in target
      ? { teamId: target.teamId, orgId: null, ticket: null }
      : { view: target.view, teamId: null, orgId: null, ticket: null };

  const navigate = (target: Target, event?: React.MouseEvent<HTMLAnchorElement>) => {
    if (event) {
      if (!isPlainClick(event)) return;
      event.preventDefault();
    }
    openedFromList.current = false;
    updateInboxUrl(patchFor(target), 'push');
  };

  const prefetch = useCallback(
    (ticket: TicketSummaryDto) => {
      if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
      prefetchTimer.current = setTimeout(() => {
        void queryClient.prefetchQuery({
          queryKey: ticketKeys.detail(ticket.ref),
          queryFn: ({ signal }) => fetchTicket(ticket.ref, signal),
        });
        void queryClient.prefetchQuery({
          queryKey: ticketKeys.messages(ticket.id),
          queryFn: ({ signal }) => loadThread(queryClient, ticket.id, signal),
        });
      }, PREFETCH_DELAY_MS);
    },
    [queryClient],
  );

  const team = state.teamId ? staffCounts?.teams.find((tm) => tm.id === state.teamId) : undefined;
  let title: string;
  if (state.orgId) title = company.data ? placeName(company.data, locale) : t('company.title');
  else if (state.teamId) title = team ? teamName(team, locale) : t('team');
  else title = t(`view.${state.view}`);
  let count: number | null;
  // Searches and the company view have no server count: the rows, once they are all loaded.
  if (state.q || state.orgId) count = settled && !list.hasNextPage ? items.length : null;
  else if (state.teamId) count = team?.count ?? null;
  else count = staffCounts?.views[state.view] ?? null;

  const selectedSummary = items.find((ticket) => isSelectedTicket(state.ticket, ticket));

  return (
    <div className="grid h-[calc(100dvh-60px)] grid-cols-[minmax(0,1fr)] min-[860px]:grid-cols-[320px_minmax(0,1fr)] min-[1180px]:grid-cols-[230px_340px_minmax(0,1fr)]">
      <h1 className="sr-only">{t('title')}</h1>

      <ViewsSidebar
        className="hidden min-[1180px]:flex"
        state={state}
        counts={staffCounts}
        countsLoading={counts.isPending}
        hrefFor={(target) => inboxHref({ ...state, ...patchFor(target) })}
        onNavigate={navigate}
      />

      <TicketList
        className={cn(
          'border-line min-[860px]:border-e',
          state.ticket ? 'max-[859px]:hidden' : undefined,
        )}
        title={title}
        count={count}
        viewSelect={
          <ViewSelect
            state={state}
            counts={staffCounts}
            teamLabel={title}
            companyLabel={state.orgId ? title : undefined}
            onChange={(target) => navigate(target)}
          />
        }
        filter={
          state.orgId ? (
            <CompanyFilter
              href={inboxHref({ ...state, orgId: null, ticket: null })}
              onClear={(event) => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                openedFromList.current = false;
                updateInboxUrl({ orgId: null, ticket: null }, 'push');
                // The chip goes away with the company view: keep the focus on the list.
                focusInboxList();
              }}
            />
          ) : null
        }
        sort={sort}
        onSortChange={setSort}
        items={items}
        isLoading={list.isPending}
        isError={list.isError}
        onRetry={() => void list.refetch()}
        isStale={list.isPlaceholderData}
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        search={state.q}
        isSelected={(ticket) => isSelectedTicket(state.ticket, ticket)}
        hrefFor={(ticket) => inboxHref({ ...state, ticket: ticket.ref })}
        onSelect={selectTicket}
        onPrefetch={prefetch}
      />

      <div
        className={cn(
          'min-h-0 min-w-0 overflow-hidden bg-surface',
          state.ticket ? undefined : 'max-[859px]:hidden',
        )}
      >
        <ConversationPane
          ticketRef={state.ticket}
          summary={selectedSummary}
          onBack={backToList}
          focusOnOpen={!!state.ticket && focusRef === state.ticket}
        />
      </div>
    </div>
  );
}
