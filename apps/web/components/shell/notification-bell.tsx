'use client';

import { notificationNewPayloadSchema, type NotificationDto } from '@loons/shared';
import { Bell, Check } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import {
  badgeText,
  notificationHref,
  notificationItems,
  unreadCountOf,
  useMarkNotificationsRead,
  useNotifications,
  useNotificationText,
} from '@/lib/notifications';
import { useRealtimeEvent } from '@/lib/realtime/hooks';
import { cn } from '@/lib/utils';

type NotificationsQuery = ReturnType<typeof useNotifications>;
type MarkRead = ReturnType<typeof useMarkNotificationsRead>;

/**
 * Console bell (Phase 3, D13; not in the approved design — built in its language): a ghost icon
 * button in the top bar with a red unread badge ("9+" above nine; the exact count is in the
 * button's name), opening a 380 px popover (the screen width minus the gutters on phones) with
 * the notifications newest first, "Mark all as read", per-item "Mark as read" and "Show older
 * notifications" (cursor paging). An item links to its ticket in the inbox and is marked read on
 * the way. New notifications arrive live (`notification:new` → the query cache) and are announced
 * once in a polite live region. Radix handles Escape, focus return and the dialog role.
 *
 * Focus never falls to the page while the popover is open: "Mark as read" hands it to its item
 * (the check button goes away), "Mark all as read" stays focusable (aria-disabled once nothing
 * is unread) and "Show older notifications" hands it to the first newly loaded item.
 */
export function NotificationBell({ className }: { className?: string }) {
  const t = useTranslations('console.notifications');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const query = useNotifications();
  const markRead = useMarkNotificationsRead();
  const text = useNotificationText();
  const unread = unreadCountOf(query.data);
  const panel = useRef<HTMLDivElement>(null);

  // Each pushed notification is announced once (a repeated push is not), as a fresh node so two
  // notifications with the same words are both read out.
  const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null);
  const announced = useRef(new Set<string>());
  useRealtimeEvent('notification:new', (payload) => {
    const parsed = notificationNewPayloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const { notification } = parsed.data;
    if (announced.current.has(notification.id)) return;
    announced.current.add(notification.id);
    setAnnouncement({
      id: notification.id,
      text: t('announce', { text: text(notification).plain }),
    });
  });

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('label', { count: unread, n: formatNumber(unread, locale) })}
            className={cn('relative text-ink-secondary', className)}
          >
            <Bell aria-hidden="true" className="size-[18px]" />
            {unread > 0 ? (
              <span
                aria-hidden="true"
                data-slot="unread-badge"
                className="absolute -top-0.5 -end-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 font-mono text-[10px] leading-none font-semibold text-primary-foreground ring-2 ring-surface"
              >
                {badgeText(unread)}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          ref={panel}
          align="end"
          sideOffset={10}
          collisionPadding={16}
          aria-label={t('title')}
          onOpenAutoFocus={(event) => {
            // Start on the newest notification (else Radix focuses the first control).
            const first = panel.current?.querySelector<HTMLElement>('[data-notification-link]');
            if (first) {
              event.preventDefault();
              first.focus();
            }
          }}
          className="w-[min(380px,calc(100vw-32px))] gap-0 overflow-hidden p-0"
        >
          <NotificationPanel query={query} markRead={markRead} onNavigate={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement ? <span key={announcement.id}>{announcement.text}</span> : null}
      </span>
    </>
  );
}

export interface NotificationPanelProps {
  query: Pick<
    NotificationsQuery,
    'data' | 'isPending' | 'isError' | 'refetch' | 'hasNextPage' | 'fetchNextPage'
  > & { isFetchingNextPage: boolean };
  markRead: Pick<MarkRead, 'mutate'>;
  /** An item link was followed (the popover closes). */
  onNavigate?: () => void;
}

/** The popover's content: header, the list (or its loading / error / empty state), paging. */
export function NotificationPanel({ query, markRead, onNavigate }: NotificationPanelProps) {
  const t = useTranslations('console.notifications');
  const titleId = useId();
  const items = notificationItems(query.data);
  const unread = unreadCountOf(query.data);
  const now = useNow({ updateInterval: 60_000 }).getTime();
  const list = useRef<HTMLDivElement>(null);
  // "Show older" pressed from the keyboard / mouse: focus the first item of the new page.
  const focusFrom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const from = focusFrom.current;
    if (from === null || items.length <= from) return;
    focusFrom.current = null;
    list.current?.querySelectorAll<HTMLElement>('[data-notification-focus]')[from]?.focus();
  }, [items.length]);
  /** Mark all, up to the newest one shown (one arriving meanwhile stays unread). */
  const markAll = () => {
    if (unread === 0) return;
    const newest = items.reduce<string | null>(
      (max, n) => (max === null || Date.parse(n.createdAt) > Date.parse(max) ? n.createdAt : max),
      null,
    );
    markRead.mutate(newest ? { all: true, upTo: newest } : { all: true });
  };

  let body: React.ReactNode;
  if (query.isPending) {
    body = <p className="px-4 py-6 text-center text-ink-muted">{t('loading')}</p>;
  } else if (query.isError && items.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
        <p className="text-ink-secondary">{t('loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  } else if (items.length === 0) {
    body = <p className="px-4 py-6 text-center text-ink-muted">{t('empty')}</p>;
  } else {
    body = (
      <ul aria-labelledby={titleId} className="flex flex-col">
        {items.map((item) => (
          <NotificationItem
            key={item.id}
            notification={item}
            now={now}
            onMarkRead={() => markRead.mutate({ ids: [item.id] })}
            onFollow={() => {
              if (item.readAt === null) markRead.mutate({ ids: [item.id] });
              onNavigate?.();
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="flex max-h-[min(560px,calc(100dvh-96px))] flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-divider px-4 py-3">
        <h2 id={titleId} className="text-[15px] font-semibold text-ink">
          {t('title')}
        </h2>
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-disabled={unread === 0 || undefined}
          onClick={markAll}
          className="text-[13px] aria-disabled:cursor-default aria-disabled:opacity-50"
        >
          {t('markAllRead')}
        </Button>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {body}
        {query.hasNextPage ? (
          <div className="border-t border-divider p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-brand-ink"
              aria-disabled={query.isFetchingNextPage || undefined}
              onClick={(event) => {
                if (query.isFetchingNextPage) return;
                // The button goes away with the last page: continue from the first new item.
                if (document.activeElement === event.currentTarget)
                  focusFrom.current = items.length;
                void query.fetchNextPage();
              }}
            >
              {query.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationItem({
  notification,
  now,
  onMarkRead,
  onFollow,
}: {
  notification: NotificationDto;
  now: number;
  onMarkRead: () => void;
  onFollow: () => void;
}) {
  const t = useTranslations('console.notifications');
  const locale = useLocale();
  const words = useNotificationText()(notification);
  const titleId = useId();
  const unread = notification.readAt === null;
  const href = notificationHref(notification);
  const subject = notification.data.subject?.trim();
  const focusTarget = useRef<HTMLElement | null>(null);
  // "Mark as read" removes its own button: keep the keyboard user on the item.
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!unread && refocus.current) {
      refocus.current = false;
      focusTarget.current?.focus();
    }
  }, [unread]);

  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          // Forced colors drop backgrounds: the dot is drawn in the text colour there.
          unread ? 'bg-brand forced-colors:bg-[CanvasText]' : 'bg-transparent',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={titleId} className="text-[13px] leading-[1.4] text-ink">
          {unread ? <span className="sr-only">{`${t('unreadPrefix')} `}</span> : null}
          {words.rich}
        </span>
        {subject ? (
          <span className="truncate text-xs text-ink-secondary">
            <bdi>{subject}</bdi>
          </span>
        ) : null}
        <time dateTime={notification.createdAt} className="text-xs text-ink-muted">
          {formatRelativeTime(notification.createdAt, locale, now)}
        </time>
      </span>
    </>
  );

  const rowClass = cn(
    'flex w-full gap-2.5 py-3 ps-4 text-start no-underline',
    unread ? 'pe-12' : 'pe-4',
  );

  return (
    <li
      data-unread={unread || undefined}
      className={cn(
        'relative border-b border-divider last:border-b-0',
        unread ? 'bg-brand-wash-subtle' : 'bg-surface',
      )}
    >
      {href ? (
        <Link
          ref={(el) => {
            focusTarget.current = el;
          }}
          href={href as Route}
          data-notification-link=""
          data-notification-focus=""
          onClick={onFollow}
          className={cn(
            rowClass,
            'text-ink outline-none hover:bg-surface-muted hover:text-ink focus-visible:bg-surface-muted focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2',
          )}
        >
          {content}
        </Link>
      ) : (
        <div
          ref={(el) => {
            focusTarget.current = el;
          }}
          tabIndex={-1}
          data-notification-focus=""
          className={cn(rowClass, 'outline-none')}
        >
          {content}
        </div>
      )}
      {unread ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('markRead')}
          aria-describedby={titleId}
          onClick={(event) => {
            refocus.current = document.activeElement === event.currentTarget;
            onMarkRead();
          }}
          className="absolute top-2.5 end-3 text-ink-muted hover:text-ink"
        >
          <Check aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}
