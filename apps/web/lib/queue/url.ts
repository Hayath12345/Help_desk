'use client';

// URL state of the Team queue (docs/PHASE5_CONTRACT.md F3, F4, F7):
//   /console/queue?tab=&priority=&category=&assignee=&q=
// - tab       one of QUEUE_TABS (default "open"; omitted from the URL when default)
// - priority  P1–P4
// - category  a category id (uuid)
// - assignee  a staff member's id (uuid), or "none" (unassigned)
// - q         the top-bar search (≤ 100 characters, like the API)
// Changes go through the native History API (as in the Inbox), which Next.js syncs with
// useSearchParams(): switching tabs or filters pushes a history entry (Back restores the previous
// list), search typing replaces it. Nothing reloads and no server component is refetched.

import {
  PRIORITIES,
  QUEUE_TABS,
  QUEUE_TAB_SORTS,
  QUEUE_TAB_VIEWS,
  UNASSIGNED_FILTER,
  isActiveStatus,
  type Priority,
  type QueueTab,
  type TicketStatus,
} from '@loons/shared';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { SEARCH_MAX, inboxHref } from '@/components/console/inbox-url';
import type { TicketListFilters } from '@/lib/tickets/keys';
import type { QueueFilters } from './keys';

export const QUEUE_PATH = '/console/queue';
export const DEFAULT_QUEUE_TAB: QueueTab = 'open';

export interface QueueState {
  tab: QueueTab;
  priority: Priority | null;
  /** Category id (lower-case uuid). */
  categoryId: string | null;
  /** A staff member's id (lower-case uuid), or UNASSIGNED_FILTER ("none"). */
  assigneeId: string | null;
  q: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isQueueTab(value: string | null | undefined): value is QueueTab {
  return !!value && (QUEUE_TABS as readonly string[]).includes(value);
}

export function isPriority(value: string | null | undefined): value is Priority {
  return !!value && (PRIORITIES as readonly string[]).includes(value);
}

interface ParamsLike {
  get(name: string): string | null;
}

const uuidOrNull = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? '';
  return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
};

/** Reads the queue state from a query string; anything malformed falls back to the default. */
export function parseQueueParams(params: ParamsLike | null | undefined): QueueState {
  const tab = params?.get('tab');
  const priority = params?.get('priority');
  const assignee = params?.get('assignee')?.trim();
  return {
    tab: isQueueTab(tab) ? tab : DEFAULT_QUEUE_TAB,
    priority: isPriority(priority) ? priority : null,
    categoryId: uuidOrNull(params?.get('category')),
    assigneeId: assignee === UNASSIGNED_FILTER ? UNASSIGNED_FILTER : uuidOrNull(assignee),
    q: (params?.get('q') ?? '').trim().slice(0, SEARCH_MAX),
  };
}

/** `?tab=…&priority=…` for a state (defaults omitted, stable order); '' for the default state. */
export function queueQuery(state: Partial<QueueState>): string {
  const params = new URLSearchParams();
  if (state.tab && state.tab !== DEFAULT_QUEUE_TAB) params.set('tab', state.tab);
  if (state.priority) params.set('priority', state.priority);
  if (state.categoryId) params.set('category', state.categoryId);
  if (state.assigneeId) params.set('assignee', state.assigneeId);
  const q = state.q?.trim().slice(0, SEARCH_MAX);
  if (q) params.set('q', q);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** `/console/queue?…` for a state (links from other pages, e.g. the Reports tiles). */
export function queueHref(state: Partial<QueueState> = {}): string {
  return `${QUEUE_PATH}${queueQuery(state)}`;
}

/** The queue state of the current browser URL (outside React; used by event handlers). */
export function currentQueueState(): QueueState {
  if (typeof window === 'undefined') return parseQueueParams(null);
  return parseQueueParams(new URLSearchParams(window.location.search));
}

/**
 * Applies `patch` to the query string of the current page (the queue). `push` adds a history
 * entry (tabs, filters: Back returns to the previous list), `replace` doesn't (search typing).
 * No-op when nothing changes.
 */
export function updateQueueUrl(
  patch: Partial<QueueState>,
  mode: 'push' | 'replace' = 'push',
): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const query = queueQuery({ ...currentQueueState(), ...patch });
  if (query === search) return;
  const href = `${pathname}${query}${hash}`;
  if (mode === 'push') window.history.pushState(null, '', href);
  else window.history.replaceState(null, '', href);
}

/** The queue state of the current URL (re-renders on pushState / replaceState / Back). */
export function useQueueState(): QueueState {
  const searchParams = useSearchParams();
  return useMemo(() => parseQueueParams(searchParams), [searchParams]);
}

/** Whether any filter or the search narrows the queue. */
export function hasQueueFilters(state: QueueState): boolean {
  return !!(state.priority || state.categoryId || state.assigneeId || state.q);
}

/** GET /tickets/queue-counts filters of a state: the filters and search (every tab). */
export function queueFiltersFor(state: QueueState): QueueFilters {
  return {
    priority: state.priority ?? undefined,
    categoryId: state.categoryId ?? undefined,
    assigneeId: state.assigneeId ?? undefined,
    search: state.q || undefined,
  };
}

/**
 * GET /tickets filters of a state: the same filters and search, plus the tab's view
 * (QUEUE_TAB_VIEWS) and sort (QUEUE_TAB_SORTS: P1 → P4 then the next SLA due date on the open
 * tabs, most recent first on Solved).
 */
export function queueListFiltersFor(state: QueueState): TicketListFilters {
  return {
    ...queueFiltersFor(state),
    view: QUEUE_TAB_VIEWS[state.tab],
    sort: QUEUE_TAB_SORTS[state.tab],
  };
}

/**
 * Where a queue row opens (F7): the ticket in the Inbox — in the Solved view when it is solved or
 * closed (it is not in "All open"), in All open otherwise.
 */
export function queueTicketHref(ticket: { ref: string; status: TicketStatus }): string {
  return inboxHref({ view: isActiveStatus(ticket.status) ? 'open' : 'solved', ticket: ticket.ref });
}
