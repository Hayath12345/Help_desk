'use client';

// URL state of the agent inbox (docs/PHASE2_CONTRACT.md → Agent console):
//   /console/inbox?view=&team=&org=&ticket=&q=
// - view    one of STAFF_VIEWS (default "mine"; omitted from the URL when default)
// - team    a team id (uuid) — replaces the view while set (design: Teams column)
// - org     a client organisation id (uuid) — the company view (Phase 5 F9): every ticket of that
//           company, any status. Replaces the view and the team while set; the view stays in the
//           URL, so clearing the company returns to it.
// - ticket  the open conversation ("LG-4817" or a uuid)
// - q       the top-bar search (≤ 100 characters, like the API)
// Changes go through the native History API, which Next.js syncs with useSearchParams(), so
// selecting a ticket or switching views never reloads the page or refetches server components.

import { STAFF_VIEWS, TICKET_SORTS, type StaffView, type TicketSort } from '@loons/shared';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { normalizeTicketRef, type TicketListFilters } from '@/lib/tickets/keys';

export const INBOX_PATH = '/console/inbox';
export const DEFAULT_VIEW: StaffView = 'mine';
/** The API caps `search` at 100 characters. */
export const SEARCH_MAX = 100;

export interface InboxState {
  view: StaffView;
  /** Team id; when set the list shows that team's active tickets instead of `view`. */
  teamId: string | null;
  /**
   * Client organisation id (company view, F9); when set the list shows all of that company's
   * tickets (any status) instead of `view` or `teamId`.
   */
  orgId: string | null;
  /** Normalised ticket reference ("LG-4817" or a lower-case uuid). */
  ticket: string | null;
  q: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStaffView(value: string | null | undefined): value is StaffView {
  return !!value && (STAFF_VIEWS as readonly string[]).includes(value);
}

export function isTicketSort(value: string): value is TicketSort {
  return (TICKET_SORTS as readonly string[]).includes(value);
}

interface ParamsLike {
  get(name: string): string | null;
}

/** Reads the inbox state from a query string; anything malformed falls back to the default. */
export function parseInboxParams(params: ParamsLike | null | undefined): InboxState {
  const view = params?.get('view');
  const team = params?.get('team')?.trim() ?? '';
  const org = params?.get('org')?.trim() ?? '';
  const ticket = params?.get('ticket')?.trim() ?? '';
  const q = params?.get('q') ?? '';
  const orgId = UUID.test(org) ? org.toLowerCase() : null;
  return {
    view: isStaffView(view) ? view : DEFAULT_VIEW,
    // The company view replaces the team (one list at a time).
    teamId: !orgId && UUID.test(team) ? team.toLowerCase() : null,
    orgId,
    ticket: ticket && ticket.length <= 64 ? normalizeTicketRef(ticket) : null,
    q: q.trim().slice(0, SEARCH_MAX),
  };
}

/** `?view=…&ticket=…` for a state (defaults omitted, stable order); '' for the default state. */
export function inboxQuery(state: Partial<InboxState>): string {
  const params = new URLSearchParams();
  if (state.orgId) {
    // The view is kept underneath the company view: clearing the company returns to it.
    if (state.view && state.view !== DEFAULT_VIEW) params.set('view', state.view);
    params.set('org', state.orgId);
  } else if (state.teamId) params.set('team', state.teamId);
  else if (state.view && state.view !== DEFAULT_VIEW) params.set('view', state.view);
  if (state.ticket) params.set('ticket', state.ticket);
  const q = state.q?.trim().slice(0, SEARCH_MAX);
  if (q) params.set('q', q);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** `/console/inbox?…` for a state (links, navigation from other console pages). */
export function inboxHref(state: Partial<InboxState>): string {
  return `${INBOX_PATH}${inboxQuery(state)}`;
}

/**
 * The GET /tickets filters of the list for a state. A team shows its active tickets (design:
 * `act(t) && team`), so it is combined with the "open" view — the same set the team count covers.
 * A company (F9) lists every ticket of that organisation: `orgId` without a view (all statuses).
 */
export function listFiltersFor(state: InboxState, sort: TicketSort): TicketListFilters {
  let target: TicketListFilters;
  if (state.orgId) target = { orgId: state.orgId };
  else if (state.teamId) target = { teamId: state.teamId, view: 'open' };
  else target = { view: state.view };
  return {
    ...target,
    search: state.q || undefined,
    sort,
  };
}

/** True when `ticket` (a row) is the one the URL points at. */
export function isSelectedTicket(
  selected: string | null,
  ticket: { id: string; ref: string },
): boolean {
  if (!selected) return false;
  return selected === ticket.id || selected === normalizeTicketRef(ticket.ref);
}

/** The inbox state of the current browser URL (outside React; used by event handlers). */
export function currentInboxState(): InboxState {
  if (typeof window === 'undefined') return parseInboxParams(null);
  return parseInboxParams(new URLSearchParams(window.location.search));
}

/**
 * Applies `patch` to the query string of the current page (the inbox). `push` adds a history
 * entry (Back returns to the previous view / list), `replace` doesn't (search typing,
 * auto-selection). No-op when nothing changes.
 */
export function updateInboxUrl(
  patch: Partial<InboxState>,
  mode: 'push' | 'replace' = 'push',
): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  const query = inboxQuery({ ...currentInboxState(), ...patch });
  if (query === search) return;
  const href = `${pathname}${query}${hash}`;
  if (mode === 'push') window.history.pushState(null, '', href);
  else window.history.replaceState(null, '', href);
}

/** The inbox state of the current URL (re-renders on pushState / replaceState / Back). */
export function useInboxState(): InboxState {
  const searchParams = useSearchParams();
  return useMemo(() => parseInboxParams(searchParams), [searchParams]);
}
