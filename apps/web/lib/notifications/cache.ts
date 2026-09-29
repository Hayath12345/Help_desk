// Pure cache helpers for the notifications list (an infinite query of NotificationList pages).
// The unread count lives on the first page (`pages[0].unreadCount`): the API returns the caller's
// total with every page, and realtime / mark-read answers keep that one up to date.

import type { NotificationDto, NotificationList, NotificationNewPayload } from '@loons/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { notificationKeys } from './keys';

export type NotificationPages = InfiniteData<NotificationList>;

/** Every loaded notification, newest first (all pages, duplicates across pages dropped). */
export function notificationItems(data: NotificationPages | undefined): NotificationDto[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: NotificationDto[] = [];
  for (const page of data.pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** The caller's unread notifications (all of them, not only the loaded pages). */
export function unreadCountOf(data: NotificationPages | undefined): number {
  return data?.pages[0]?.unreadCount ?? 0;
}

/** "9+" above nine (the badge stays one pill wide); the exact number goes into the label. */
export function badgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

const newestFirst = (a: NotificationDto, b: NotificationDto) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

function withFirstPage(
  data: NotificationPages,
  update: (page: NotificationList) => NotificationList,
): NotificationPages {
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return { ...data, pages: [update(first), ...rest] };
}

/**
 * Adds a pushed notification (`notification:new`) to the loaded list, newest first, and takes
 * the server's unread count. A notification already in the list (a repeated push, or one the
 * last fetch already returned) is not added twice.
 */
export function insertNotification(
  data: NotificationPages,
  payload: NotificationNewPayload,
): NotificationPages {
  const known = data.pages.some((page) => page.items.some((i) => i.id === payload.notification.id));
  return withFirstPage(data, (page) => ({
    ...page,
    items: known ? page.items : [payload.notification, ...page.items].sort(newestFirst),
    unreadCount: payload.unreadCount,
  }));
}

/**
 * Marks notifications as read in the loaded pages (`'all'` = every one) and lowers the unread
 * count by the ones that changed (to 0 for `'all'`: unloaded pages are read too). Returns the
 * same object when nothing changed.
 */
export function markReadInPages(
  data: NotificationPages,
  ids: readonly string[] | 'all',
  readAt: string,
): NotificationPages {
  const targets = ids === 'all' ? null : new Set(ids);
  let changed = 0;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      if (item.readAt !== null || (targets && !targets.has(item.id))) return item;
      pageChanged = true;
      changed += 1;
      return { ...item, readAt };
    });
    return pageChanged ? { ...page, items } : page;
  });
  const before = unreadCountOf(data);
  const unreadCount = ids === 'all' ? 0 : Math.max(0, before - changed);
  if (changed === 0 && unreadCount === before) return data;
  return withFirstPage({ ...data, pages }, (page) => ({ ...page, unreadCount }));
}

/** Takes the server's unread count (mark-read answers). */
export function setUnreadCount(data: NotificationPages, unreadCount: number): NotificationPages {
  if (unreadCountOf(data) === unreadCount) return data;
  return withFirstPage(data, (page) => ({ ...page, unreadCount }));
}

/**
 * `notification:new` → the bell's cache. When the list hasn't loaded yet (or its first load is
 * in flight, whose answer may predate this notification), it is refetched instead.
 */
export function applyNewNotification(
  queryClient: QueryClient,
  payload: NotificationNewPayload,
): void {
  const key = notificationKeys.list();
  const query = queryClient.getQueryCache().find<NotificationPages>({ queryKey: key, exact: true });
  if (!query) return; // nobody shows notifications in this tab
  if (query.state.data === undefined) {
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
    return;
  }
  queryClient.setQueryData<NotificationPages>(key, (old) =>
    old ? insertNotification(old, payload) : old,
  );
}
