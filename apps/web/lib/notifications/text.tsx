'use client';

// In-app notifications are stored as `type` + `data` (decision D13) and worded here, in the
// viewer's language: `console.notifications.types.<TYPE>` with ICU selects for the optional
// parts. The ticket number is isolated left-to-right (a `<bdi dir="ltr">` in the list, LRI…PDI in
// plain text) and names first-strong isolated, so "LG-4821" and a Latin name keep their order
// inside Arabic sentences.

import { NOTIFICATION_TYPES, type NotificationDto, type NotificationType } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { formatNumber, formatTicketNumber, isolate, isolateDirection } from '@/lib/format';

export interface NotificationText {
  /** For the list: the ticket number in a `<bdi dir="ltr">`. */
  rich: React.ReactNode;
  /** For live-region announcements and labels. */
  plain: string;
}

const isKnownType = (type: string): type is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(type);

/** Link target of a notification: the ticket in the console inbox (null without a ticket). */
export function notificationHref(notification: NotificationDto): string | null {
  if (notification.ticketNumber === null) return null;
  return `/console/inbox?ticket=${formatTicketNumber(notification.ticketNumber)}`;
}

/** Words a notification in the UI language (see the module comment). */
export function useNotificationText(): (notification: NotificationDto) => NotificationText {
  const t = useTranslations('console.notifications');
  const tStatus = useTranslations('common.status');
  const locale = useLocale();

  return useCallback(
    (notification) => {
      const { data } = notification;
      const actor = data.actor?.name.trim() ?? '';
      const values = {
        ref:
          notification.ticketNumber === null
            ? t('aTicket')
            : formatTicketNumber(notification.ticketNumber),
        hasActor: actor ? 'yes' : 'no',
        actor: actor ? isolate(actor) : '',
        hasStatus: data.status ? 'yes' : 'no',
        status: data.status ? tStatus(data.status) : '',
        target: data.target ?? 'other',
        hasStep: data.step ? 'yes' : 'no',
        step: data.step ? formatNumber(data.step, locale) : '',
      };
      const key = isKnownType(notification.type)
        ? (`types.${notification.type}` as const)
        : ('types.generic' as const);
      return {
        rich: t.rich(key, {
          ...values,
          ticket: (chunks) => (
            <bdi dir="ltr" className="font-medium whitespace-nowrap">
              {chunks}
            </bdi>
          ),
        }),
        plain: t.markup(key, {
          ...values,
          ticket: (chunks) => isolateDirection(chunks, 'ltr'),
        }),
      };
    },
    [t, tStatus, locale],
  );
}
