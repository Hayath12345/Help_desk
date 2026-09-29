// Typed fetchers for the in-app notifications (docs/PHASE3_CONTRACT.md → API: GET
// /me/notifications, POST /me/notifications/read). Responses are parsed with the shared contract
// schemas outside production, like the ticket fetchers.

import {
  markNotificationsReadResponseSchema,
  notificationListSchema,
  type MarkNotificationsReadInput,
  type MarkNotificationsReadResponse,
  type NotificationList,
} from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';

/** Notifications per page in the bell (the API allows 1–50; default 20). */
export const NOTIFICATION_PAGE_SIZE = 20;

/** One page of the caller's notifications, newest first; `cursor` = the previous `nextCursor`. */
export async function fetchNotifications(
  cursor: string | null,
  signal?: AbortSignal,
): Promise<NotificationList> {
  const data = await apiClient.get<unknown>(
    withQuery('/me/notifications', { cursor, limit: NOTIFICATION_PAGE_SIZE }),
    { signal },
  );
  return parseResponse(notificationListSchema, data);
}

/** Marks some (`{ids}`) or all (`{all: true}`) of the caller's notifications as read. */
export async function markNotificationsRead(
  input: MarkNotificationsReadInput,
): Promise<MarkNotificationsReadResponse> {
  const data = await apiClient.post<unknown>('/me/notifications/read', input);
  return parseResponse(markNotificationsReadResponseSchema, data);
}
