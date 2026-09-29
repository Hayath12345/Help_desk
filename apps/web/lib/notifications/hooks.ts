'use client';

// TanStack Query hooks of the console bell. Realtime (`notification:new`, lib/realtime/provider)
// inserts pushed notifications into the same cache, so the list doesn't poll.

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { fetchNotifications, markNotificationsRead } from './api';
import { markReadInPages, setUnreadCount, type NotificationPages } from './cache';
import { notificationKeys } from './keys';

/**
 * The caller's notifications, newest first (infinite; `fetchNextPage` while `hasNextPage`).
 * Loaded when the console mounts (the badge needs the unread count).
 */
export function useNotifications(options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: notificationKeys.list(),
    queryFn: ({ pageParam, signal }) => fetchNotifications(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: 1,
    enabled: options.enabled ?? true,
  });
}

export type MarkReadVariables = { ids: string[] } | { all: true; upTo?: string };

/**
 * POST /me/notifications/read, optimistic: the items turn read and the badge drops at once; the
 * answer's unread count wins. On failure the list is reloaded (the server's state wins) and a
 * toast explains why.
 */
export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  const t = useTranslations('console.notifications');
  const errorText = useApiErrorText();
  const key = notificationKeys.list();

  return useMutation({
    mutationKey: ['notifications', 'read'],
    mutationFn: (variables: MarkReadVariables) => markNotificationsRead(variables),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: key });
      const readAt = new Date().toISOString();
      queryClient.setQueryData<NotificationPages>(key, (old) =>
        old ? markReadInPages(old, 'all' in variables ? 'all' : variables.ids, readAt) : old,
      );
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.error(t('markReadFailed', { reason: errorText(error) }));
    },
    onSuccess: (result) => {
      // Another mark-read still in flight has already lowered the count further: its answer
      // (the latest) sets it.
      if (queryClient.isMutating({ mutationKey: ['notifications', 'read'] }) > 1) return;
      queryClient.setQueryData<NotificationPages>(key, (old) =>
        old ? setUnreadCount(old, result.unreadCount) : old,
      );
    },
  });
}
