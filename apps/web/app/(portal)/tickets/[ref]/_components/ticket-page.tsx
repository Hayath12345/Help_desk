'use client';

import type { TicketDetailDto } from '@loons/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { NewTicketButton } from '@/components/shell/new-ticket-button';
import { TicketThread } from '@/components/tickets/ticket-thread';
import { TypingIndicator } from '@/components/tickets/typing-indicator';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { isApiRequestError } from '@/lib/api/errors';
import { useRealtimeStatus, useTicketRoom, useTyping } from '@/lib/realtime/hooks';
import { useSendMessage } from '@/lib/tickets/mutations';
import { useMessages, useTicket } from '@/lib/tickets/queries';
import { cn } from '@/lib/utils';
import { BackLink } from './back-link';
import { ReplyComposer } from './reply-composer';
import { TicketHeader } from './ticket-header';
import { TicketNotFound } from './ticket-not-found';
import { TicketPageSkeleton } from './ticket-page-skeleton';

/** A reconnect shorter than this (token refresh, a network blip) isn't worth mentioning. */
export const RECONNECT_NOTICE_DELAY_MS = 3000;

/**
 * Client ticket thread page (design 637–668). Loads the ticket by its `LG-n` reference, then
 * joins its realtime room: agents' public replies slide into the thread, status / assignee
 * changes update the header, and after a reconnect the thread fetches what it missed.
 */
export function TicketPage({ ticketRef }: { ticketRef: string }) {
  const t = useTranslations('portal.ticket');
  const query = useTicket(ticketRef);

  if (query.data) return <TicketView ticket={query.data} />;
  if (query.isError) {
    if (isApiRequestError(query.error) && query.error.status === 404) return <TicketNotFound />;
    return (
      <div className="flex flex-col gap-[18px]">
        <BackLink />
        <Card role="alert" className="items-start gap-3 p-5">
          <p className="font-medium text-ink">{t('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t('retry')}
          </Button>
        </Card>
      </div>
    );
  }
  return <TicketPageSkeleton label={t('loading')} />;
}

function TicketView({ ticket }: { ticket: TicketDetailDto }) {
  useTicketRoom(ticket.id);
  const messages = useMessages(ticket.id);
  const sender = useSendMessage(ticket.id);
  const typing = useTyping(ticket.id);
  // Only the ticket room's typing reaches a client (colleagues on the same ticket); staff typing
  // goes to the staff room. Filter anyway so an internal-note typist could never show here.
  const typists = useMemo(
    () => typing.typingUsers.filter((user) => user.scope === 'public'),
    [typing.typingUsers],
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <BackLink />
      <TicketHeader ticket={ticket} />
      {/* The notices below stay mounted (polite live regions) but take no room while empty. */}
      <div className="flex flex-col">
        <LiveNotice />
        <TicketThread
          messages={messages.data}
          isLoading={messages.isPending}
          isError={messages.isError}
          onReload={() => void messages.refetch()}
          onRetry={sender.retry}
          onDiscard={sender.discard}
          gap="portal"
        />
        <TypingIndicator users={typists} className={cn('min-h-0', typists.length > 0 && 'mt-3')} />
      </div>
      {ticket.status === 'CLOSED' ? (
        <ClosedNotice />
      ) : (
        <ReplyComposer
          ticketId={ticket.id}
          status={ticket.status}
          onSend={sender.send}
          onTyping={typing.notifyTyping}
          onStopTyping={typing.stopTyping}
        />
      )}
    </div>
  );
}

/** Closed tickets are final (the API answers 409 to replies): offer a new ticket instead. */
function ClosedNotice() {
  const t = useTranslations('portal.ticket');
  return (
    <Card className="flex-row flex-wrap items-center justify-between gap-4 p-5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="text-[15px] font-semibold text-ink">{t('closedTitle')}</h2>
        <p className="text-ink-muted">{t('closedDescription')}</p>
      </div>
      <NewTicketButton />
    </Card>
  );
}

/**
 * "Reconnecting…" when the live connection has been down for a few seconds, or a reload hint when
 * it has stopped for good. New replies are fetched automatically once it reconnects.
 */
function LiveNotice() {
  const t = useTranslations('portal.ticket.live');
  const status = useRealtimeStatus();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const reconnecting = status === 'reconnecting';
    const timer = setTimeout(
      () => setSlow(reconnecting),
      reconnecting ? RECONNECT_NOTICE_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [status]);

  const text =
    status === 'stopped' || status === 'forbidden'
      ? t('offline')
      : status === 'reconnecting' && slow
        ? t('reconnecting')
        : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center gap-2 text-[13px] text-ink-muted', text && 'mb-3')}
    >
      {text ? (
        <>
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-warning" />
          {text}
        </>
      ) : null}
    </div>
  );
}
