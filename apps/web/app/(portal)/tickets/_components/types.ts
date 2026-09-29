import {
  CLIENT_TABS,
  formatTicketNumber,
  isActiveStatus,
  parseTicketNumber,
  type ClientTab,
  type TicketStatus,
} from '@loons/shared';
import type { TicketListFilters } from '@/lib/tickets/keys';

/** "My tickets" tabs (design: All / Active / Solved). */
export const TICKET_TABS = CLIENT_TABS;
export type TicketTab = ClientTab;

export function isTicketTab(value: unknown): value is TicketTab {
  return typeof value === 'string' && (TICKET_TABS as readonly string[]).includes(value);
}

/** Solved tab = SOLVED and CLOSED; Active = NEW, OPEN, PENDING (the API's tab predicates). */
export function matchesTab(ticket: { status: TicketStatus }, tab: TicketTab): boolean {
  if (tab === 'all') return true;
  return tab === 'active' ? isActiveStatus(ticket.status) : !isActiveStatus(ticket.status);
}

/**
 * GET /tickets filters of one tab: the tickets the client requested (`scope=mine`), newest
 * activity first. Each tab is its own cached list, so a switch back is instant.
 */
export function portalListFilters(tab: TicketTab): TicketListFilters {
  return { tab, scope: 'mine', sort: 'recent' };
}

const time = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Newest activity first (`sort=recent` is `updatedAt` desc). Re-sorting on the client lets a row
 * that a realtime push or an optimistic change just touched move to the top with its `layout`
 * animation instead of waiting for the next refetch. Stable for ties (keeps the API order).
 */
export function sortByRecent<T extends { updatedAt: string }>(tickets: readonly T[]): T[] {
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort((a, b) => time(b.ticket.updatedAt) - time(a.ticket.updatedAt) || a.index - b.index)
    .map(({ ticket }) => ticket);
}

/** Link to a ticket's thread page: `/tickets/LG-4771`. */
export function portalTicketHref(ticket: { ref: string; number: number }): string {
  const ref = /^LG-\d+$/.test(ticket.ref) ? ticket.ref : formatTicketNumber(ticket.number);
  return `/tickets/${encodeURIComponent(ref)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The (already decoded) `[ref]` segment in canonical form ("lg-4771" / "4771" → "LG-4771"; uuids
 * lower-cased), or null when it can't be a ticket reference (the page 404s without calling the API).
 */
export function canonicalTicketRef(segment: string): string | null {
  const value = segment.trim();
  if (UUID.test(value)) return value.toLowerCase();
  const n = parseTicketNumber(value);
  return n === null ? null : formatTicketNumber(n);
}
