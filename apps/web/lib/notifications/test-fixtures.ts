// Contract-valid notification DTOs for unit tests. Not imported by application code.

import type { NotificationDto, NotificationList } from '@loons/shared';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import type { NotificationPages } from './cache';

/** Notification n: id fixtureId(2000 + n), created n minutes before 12:00 (older as n grows). */
export function makeNotification(
  n: number,
  overrides: Partial<NotificationDto> = {},
): NotificationDto {
  return {
    id: fixtureId(2000 + n),
    type: 'CLIENT_REPLY',
    ticketId: fixtureId(900),
    ticketNumber: 4821,
    data: {
      subject: 'Firewall blocking the VPN',
      priority: 'P2',
      actor: { id: fixtureId(501), name: 'Dr. Aisha Al-Kuwari' },
    },
    readAt: null,
    createdAt: new Date(Date.parse('2026-09-23T12:00:00.000Z') - n * 60_000).toISOString(),
    ...overrides,
  };
}

export function makePages(
  pages: { items: NotificationDto[]; nextCursor?: string | null }[],
  unreadCount: number,
): NotificationPages {
  return {
    pages: pages.map<NotificationList>((page) => ({
      items: page.items,
      nextCursor: page.nextCursor ?? null,
      unreadCount,
    })),
    pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i}`)),
  };
}
