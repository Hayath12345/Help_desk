import type { TicketStatus } from '@loons/shared';

export const TICKET_TABS = ['all', 'active', 'solved'] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

export function isTicketTab(value: unknown): value is TicketTab {
  return typeof value === 'string' && (TICKET_TABS as readonly string[]).includes(value);
}

/** A row in the client's "My tickets" list (shape the Phase 2 API list endpoint maps into). */
export interface PortalTicketSummary {
  id: string;
  /** Sequence number; rendered as "LG-4817". */
  number: number;
  subject: string;
  /** Category label already localised (Arabic falls back to English when empty). */
  category: string;
  /** Excerpt of the latest public message. */
  preview: string;
  status: TicketStatus;
  /** ISO timestamp of the last update. */
  updatedAt: string;
}

const SOLVED_STATUSES: readonly TicketStatus[] = ['SOLVED', 'CLOSED'];

export function isSolvedStatus(status: TicketStatus): boolean {
  return SOLVED_STATUSES.includes(status);
}

export function matchesTab(ticket: PortalTicketSummary, tab: TicketTab): boolean {
  if (tab === 'all') return true;
  return tab === 'solved' ? isSolvedStatus(ticket.status) : !isSolvedStatus(ticket.status);
}
