'use client';

import {
  QUEUE_TABS,
  type BulkTicketAction,
  type QueueTab,
  type TicketSummaryDto,
} from '@loons/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import { AnimatePresence } from 'motion/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { isPlainClick } from '@/components/console/views-sidebar';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatNumber } from '@/lib/format';
import type { BulkRunOutcome, BulkRunResult } from '@/lib/queue/api';
import { invalidateQueueLive } from '@/lib/queue/keys';
import {
  useBulkTickets,
  useQueueCounts,
  useQueueFilterOptions,
  useQueueTickets,
  useWorkload,
} from '@/lib/queue/queries';
import {
  isQueueTab,
  queueFiltersFor,
  queueListFiltersFor,
  queueTicketHref,
  updateQueueUrl,
  useQueueState,
  type QueueState,
} from '@/lib/queue/url';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { ticketKeys } from '@/lib/tickets/keys';
import { useTicketCounts } from '@/lib/tickets/queries';
import { useViewer } from '@/lib/tickets/viewer';
import { AgentCards } from './agent-cards';
import { BulkBar } from './bulk-bar';
import { QueueFilters } from './queue-filters';
import { QueueTable } from './queue-table';

/** At-risk membership and the SLA countdowns change with time, not only with events (F16). */
export const QUEUE_TIME_REFRESH_MS = 60_000;

const EMPTY_ROWS: TicketSummaryDto[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** The selection belongs to one tab: switching tabs (click, Back, a link) clears it (F3). */
interface Selection {
  tab: QueueTab;
  ids: ReadonlySet<string>;
}

/**
 * Team queue (design 893–963; docs/PHASE5_CONTRACT.md F2–F7, F16): the header with the unfiltered
 * unassigned count, the agent workload cards, the tabs (All open / Unassigned / Breaching soon /
 * Solved, counted for the active filters and search), the Priority / Category / Assignee filters,
 * the bulk action bar and the table. Tab, filters and search live in the URL
 * (`?tab=&priority=&category=&assignee=&q=`, History API: Back works, links can be shared); the
 * top-bar search filters this page in place. Live: `queue:updated` and reconnects (realtime
 * provider), config changes (filter options, workload names) and a 60 s refresh while visible.
 * Rendered inside `ConsolePage` by the route.
 */
export function TeamQueue() {
  const t = useTranslations('console.queue');
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const viewer = useViewer();
  const errorText = useApiErrorText();
  const state = useQueueState();
  const filters = useMemo(() => queueFiltersFor(state), [state]);
  const listFilters = useMemo(() => queueListFiltersFor(state), [state]);

  const counts = useTicketCounts();
  const workload = useWorkload();
  const filterOptions = useQueueFilterOptions();
  const tabCounts = useQueueCounts(filters);
  const list = useQueueTickets(listFilters);
  const bulk = useBulkTickets();
  const items = list.data?.items ?? EMPTY_ROWS;
  const n = (value: number) => formatNumber(value, locale);

  // Time-based changes (Breaching soon, countdown order, agents' at-risk notes): refresh while
  // the tab is visible, like the Inbox. The header's unassigned count is the Inbox's counts.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      invalidateQueueLive(queryClient);
      void queryClient.invalidateQueries({ queryKey: ticketKeys.counts() });
    }, QUEUE_TIME_REFRESH_MS);
    return () => clearInterval(timer);
  }, [queryClient]);

  // ── Selection (checkboxes): per tab; only rows of the current list count. ──
  const [selection, setSelection] = useState<Selection>({ tab: state.tab, ids: NO_IDS });
  if (selection.tab !== state.tab) setSelection({ tab: state.tab, ids: NO_IDS });
  const selectedIds = selection.tab === state.tab ? selection.ids : NO_IDS;
  const selectedRows = items.filter((row) => selectedIds.has(row.id));
  const selectAllRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const setIds = (ids: ReadonlySet<string>) => setSelection({ tab: state.tab, ids });
  const toggleRow = (ticket: TicketSummaryDto, selected: boolean) => {
    const next = new Set(selectedIds);
    if (selected) next.add(ticket.id);
    else next.delete(ticket.id);
    setIds(next);
  };
  const selectAll = (selected: boolean) => {
    const next = new Set(selectedIds);
    for (const row of items) {
      if (selected) next.add(row.id);
      else next.delete(row.id);
    }
    setIds(next);
  };
  /** Empties the selection; focus leaves the closing bar for the select-all checkbox. */
  const clearSelection = () => {
    const focusInBar = !!barRef.current?.contains(document.activeElement);
    setIds(NO_IDS);
    if (focusInBar) selectAllRef.current?.focus();
  };

  // ── URL state ──
  const changeTab = (value: string) => {
    if (isQueueTab(value) && value !== state.tab) updateQueueUrl({ tab: value }, 'push');
  };
  const changeFilters = (
    patch: Partial<Pick<QueueState, 'priority' | 'categoryId' | 'assigneeId'>>,
  ) => updateQueueUrl(patch, 'push');
  const toggleAgent = (agentId: string) =>
    changeFilters({ assigneeId: state.assigneeId === agentId ? null : agentId });

  const openTicket = (ticket: TicketSummaryDto, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    router.push(queueTicketHref(ticket) as Route);
  };

  // ── Bulk actions (F6) ──
  const reasonText = (
    outcome: BulkRunOutcome,
    action: BulkTicketAction,
    refs: ReadonlyMap<string, string>,
  ): string | undefined => {
    if (outcome.ok) return undefined;
    if ('requestError' in outcome) return errorText(outcome.requestError);
    const { reason } = outcome.error;
    const key = reason === 'invalid' && action === 'assignToMe' ? 'invalidAssign' : reason;
    return t(`bulk.reason.${key}`, { ref: refs.get(outcome.id) ?? '' });
  };

  const announce = (
    result: BulkRunResult,
    action: BulkTicketAction,
    refs: ReadonlyMap<string, string>,
  ) => {
    // What the request did: tickets that already were that way (already assigned to the viewer,
    // already solved) are said apart, never counted as changed.
    const parts: string[] = [];
    if (result.changed > 0 || result.unchanged === 0) {
      parts.push(
        t(action === 'assignToMe' ? 'bulk.assigned' : 'bulk.solved', {
          count: result.changed,
          n: n(result.changed),
        }),
      );
    }
    if (result.unchanged > 0) {
      parts.push(
        t(action === 'assignToMe' ? 'bulk.alreadyAssigned' : 'bulk.alreadySolved', {
          count: result.unchanged,
          n: n(result.unchanged),
        }),
      );
    }
    const [first = '', second] = parts;
    const done = second === undefined ? first : t('bulk.both', { first, second });
    if (result.failed === 0) {
      toast.success(done);
      return;
    }
    const failed = t('bulk.failed', { count: result.failed, n: n(result.failed) });
    const firstFailure = result.results.find((outcome) => !outcome.ok);
    toast.error(result.updated > 0 ? t('bulk.partial', { updated: done, failed }) : failed, {
      description: firstFailure ? reasonText(firstFailure, action, refs) : undefined,
    });
  };

  const runBulk = (action: BulkTicketAction) => {
    if (bulk.isPending || selectedRows.length === 0) return;
    const rows = selectedRows;
    const refs = new Map(rows.map((row) => [row.id, row.ref]));
    bulk.mutate(
      { ids: rows.map((row) => row.id), action },
      {
        onSuccess: (result) => {
          announce(result, action, refs);
          // The tickets that couldn't be changed stay selected, so the viewer can retry them
          // (a request that failed as a whole keeps the whole selection).
          const failedIds = new Set(result.results.filter((r) => !r.ok).map((r) => r.id));
          if (failedIds.size === 0) clearSelection();
          else setIds(failedIds);
        },
        onError: (error) => {
          toast.error(t('bulk.failed', { count: rows.length, n: n(rows.length) }), {
            description: errorText(error),
          });
        },
      },
    );
  };

  // ── Header ──
  const scope = viewer?.role === 'SUPER_ADMIN' ? t('allTeams') : t('yourTeams');
  const unassigned = counts.data?.kind === 'staff' ? counts.data.views.unassigned : undefined;
  let subtitle: React.ReactNode;
  if (unassigned !== undefined) {
    subtitle = t('subtitle', { scope, count: unassigned, n: n(unassigned) });
  } else if (counts.isError) {
    subtitle = scope;
  } else {
    subtitle = (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {scope}
        <span aria-hidden="true">·</span>
        <Skeleton className="h-3.5 w-24 rounded-sm" />
      </span>
    );
  }

  const selectedCount = selectedRows.length;

  return (
    <>
      <PageHeader
        className="items-start"
        title={t('title')}
        description={subtitle}
        descriptionClassName="text-[15px] text-ink-secondary"
        actions={<NewTicketButton size="lg" className="text-[15px]" />}
      />

      <AgentCards
        workload={workload.data}
        isLoading={workload.isPending}
        isError={workload.isError}
        onRetry={() => void workload.refetch()}
        assigneeId={state.assigneeId}
        onToggle={toggleAgent}
      />

      <Tabs
        value={state.tab}
        onValueChange={changeTab}
        activationMode="manual"
        className="min-w-0 gap-[22px]"
      >
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line">
          {/*
            The active tab's 2px line covers the row's border (the list sits 1px lower). Phones:
            the list scrolls sideways, so the tabs draw their focus outline inside themselves
            (the scroller would clip the usual outside outline).
          */}
          <TabsList
            variant="line"
            aria-label={t('tabsLabel')}
            className="-mb-px max-w-full min-w-0 gap-[22px] border-b-0 max-sm:gap-3.5 max-sm:overflow-x-auto"
          >
            {QUEUE_TABS.map((key) => {
              const count = tabCounts.data?.tabs[key];
              return (
                <TabsTrigger
                  key={key}
                  value={key}
                  // Phones: the strip scrolls sideways; a tab reached with the arrow keys comes
                  // into view.
                  onFocus={(event) =>
                    event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                  }
                  className="mb-0! pb-2.5! text-[15px] max-sm:px-1 max-sm:focus-visible:-outline-offset-2"
                >
                  {t(`tabs.${key}`)}
                  {count !== undefined ? (
                    <span className="text-xs font-normal text-ink-muted tabular-nums">
                      {n(count)}
                    </span>
                  ) : tabCounts.isPending ? (
                    <Skeleton className="h-2.5 w-3 rounded-sm" />
                  ) : (
                    <span className="text-xs font-normal text-ink-muted">–</span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <QueueFilters
            className="pb-2"
            state={state}
            categories={filterOptions.data?.categories}
            agents={workload.data?.agents}
            rows={items}
            onChange={changeFilters}
          />
        </div>

        {/* Always present, so the new count is announced (the bar itself comes and goes). */}
        <p role="status" aria-live="polite" data-selection-status="" className="sr-only">
          {selectedCount ? t('bulk.selected', { count: selectedCount, n: n(selectedCount) }) : ''}
        </p>
        <AnimatePresence initial={false}>
          {selectedCount > 0 ? (
            <div ref={barRef} key="bulk">
              <BulkBar
                count={selectedCount}
                pending={bulk.isPending}
                onAssignToMe={() => runBulk('assignToMe')}
                onMarkSolved={() => runBulk('solve')}
                onClear={clearSelection}
              />
            </div>
          ) : null}
        </AnimatePresence>

        <TabsContent value={state.tab} className="mt-0 rounded-xl">
          <QueueTable
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
            isSelected={(ticket) => selectedIds.has(ticket.id)}
            onSelectedChange={toggleRow}
            onSelectAll={selectAll}
            onOpen={openTicket}
            selectAllRef={selectAllRef}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
