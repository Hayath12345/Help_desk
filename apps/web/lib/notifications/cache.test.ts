import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  applyNewNotification,
  badgeText,
  insertNotification,
  markReadInPages,
  notificationItems,
  setUnreadCount,
  unreadCountOf,
  type NotificationPages,
} from './cache';
import { notificationKeys } from './keys';
import { makeNotification, makePages } from './test-fixtures';

const READ_AT = '2026-09-23T12:30:00.000Z';
const ids = (data: NotificationPages) => notificationItems(data).map((n) => n.id);

describe('badgeText', () => {
  it('shows the count up to nine, then 9+', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(250)).toBe('9+');
  });
});

describe('notificationItems / unreadCountOf', () => {
  it('flattens the pages in order, dropping an id repeated on a later page', () => {
    const data = makePages(
      [
        { items: [makeNotification(1), makeNotification(2)], nextCursor: 'c1' },
        { items: [makeNotification(2), makeNotification(3)] },
      ],
      4,
    );
    expect(ids(data)).toEqual([1, 2, 3].map((n) => makeNotification(n).id));
    expect(unreadCountOf(data)).toBe(4);
    expect(unreadCountOf(undefined)).toBe(0);
    expect(notificationItems(undefined)).toEqual([]);
  });
});

describe('insertNotification', () => {
  it('puts a pushed notification first and takes the unread count from the push', () => {
    const data = makePages([{ items: [makeNotification(2), makeNotification(3)] }], 2);
    const next = insertNotification(data, { notification: makeNotification(0), unreadCount: 3 });
    expect(ids(next)).toEqual([0, 2, 3].map((n) => makeNotification(n).id));
    expect(unreadCountOf(next)).toBe(3);
    // The input is not mutated.
    expect(ids(data)).toHaveLength(2);
  });

  it('keeps newest-first order when a push arrives late, and never adds one twice', () => {
    const data = makePages([{ items: [makeNotification(1), makeNotification(5)] }], 2);
    const late = insertNotification(data, { notification: makeNotification(3), unreadCount: 3 });
    expect(ids(late)).toEqual([1, 3, 5].map((n) => makeNotification(n).id));
    const again = insertNotification(late, { notification: makeNotification(3), unreadCount: 3 });
    expect(ids(again)).toEqual(ids(late));
    // Not stored twice either (notificationItems would hide a duplicate).
    expect(again.pages[0]?.items).toHaveLength(3);
    // Already on a later page: not added to the first one.
    const paged = makePages(
      [{ items: [makeNotification(1)], nextCursor: 'c' }, { items: [makeNotification(7)] }],
      1,
    );
    const repeated = insertNotification(paged, {
      notification: makeNotification(7),
      unreadCount: 1,
    });
    expect(ids(repeated)).toEqual(ids(paged));
    expect(repeated.pages.map((p) => p.items.length)).toEqual([1, 1]);
  });
});

describe('markReadInPages', () => {
  const data = () =>
    makePages(
      [
        { items: [makeNotification(1), makeNotification(2)], nextCursor: 'c1' },
        { items: [makeNotification(3, { readAt: '2026-09-23T11:00:00.000Z' })] },
      ],
      7,
    );

  it('marks the given ids read and lowers the count by the ones that changed', () => {
    const next = markReadInPages(data(), [makeNotification(1).id, makeNotification(3).id], READ_AT);
    const items = notificationItems(next);
    expect(items[0]?.readAt).toBe(READ_AT);
    expect(items[1]?.readAt).toBeNull();
    // Already read: keeps its readAt and doesn't count.
    expect(items[2]?.readAt).toBe('2026-09-23T11:00:00.000Z');
    expect(unreadCountOf(next)).toBe(6);
  });

  it('marks everything read with "all" (unloaded pages too: the count drops to 0)', () => {
    const next = markReadInPages(data(), 'all', READ_AT);
    expect(notificationItems(next).every((n) => n.readAt !== null)).toBe(true);
    expect(unreadCountOf(next)).toBe(0);
  });

  it('returns the same object when nothing changes', () => {
    const before = data();
    expect(markReadInPages(before, [makeNotification(3).id], READ_AT)).toBe(before);
    expect(markReadInPages(before, [makeNotification(99).id], READ_AT)).toBe(before);
  });

  it('never goes below zero', () => {
    const next = markReadInPages(makePages([{ items: [makeNotification(1)] }], 0), 'all', READ_AT);
    expect(unreadCountOf(next)).toBe(0);
    const one = markReadInPages(
      makePages([{ items: [makeNotification(1)] }], 0),
      [makeNotification(1).id],
      READ_AT,
    );
    expect(unreadCountOf(one)).toBe(0);
  });
});

describe('setUnreadCount', () => {
  it('writes the server count on the first page only', () => {
    const data = makePages([{ items: [], nextCursor: 'c' }, { items: [] }], 4);
    const next = setUnreadCount(data, 1);
    expect(next.pages.map((p) => p.unreadCount)).toEqual([1, 4]);
    expect(setUnreadCount(next, 1)).toBe(next);
  });
});

describe('applyNewNotification', () => {
  const payload = { notification: makeNotification(0), unreadCount: 5 };

  it('inserts into a loaded list', () => {
    const qc = new QueryClient();
    qc.setQueryData(notificationKeys.list(), makePages([{ items: [makeNotification(1)] }], 4));
    applyNewNotification(qc, payload);
    const data = qc.getQueryData<NotificationPages>(notificationKeys.list())!;
    expect(ids(data)[0]).toBe(payload.notification.id);
    expect(unreadCountOf(data)).toBe(5);
  });

  it('does nothing when no bell is mounted, and refetches a list that has not loaded yet', () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue();
    applyNewNotification(qc, payload);
    expect(qc.getQueryData(notificationKeys.list())).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();

    // A query whose first load is still in flight: its answer may predate the push.
    qc.getQueryCache().build(qc, { queryKey: notificationKeys.list() });
    applyNewNotification(qc, payload);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notificationKeys.list(), exact: true });
  });
});
