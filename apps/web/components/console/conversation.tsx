'use client';

import type { TicketDetailDto } from '@loons/shared';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/common/empty-state';
import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { TicketThread } from '@/components/tickets/ticket-thread';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiRequestError } from '@/lib/api/errors';
import { fadeVariants } from '@/lib/motion';
import { useTicketRoom, useTyping } from '@/lib/realtime/hooks';
import { useSendMessage } from '@/lib/tickets/mutations';
import { useMessages, useTicket } from '@/lib/tickets/queries';
import type { AnyTicketDto } from '@/lib/tickets/types';
import { cn } from '@/lib/utils';
import { Composer, type ComposerMode } from './composer';
import { ConversationHeader } from './conversation-header';
import { TicketPanel } from './ticket-panel';

// Conversation column of the inbox (design 767–888). Below a 700 px wide column the right panel
// wraps under the conversation and everything scrolls together (as in the design); from 700 px
// the conversation and the panel sit side by side and scroll on their own, so the composer
// stays in view.

export interface ConversationPaneProps {
  /** `?ticket=` — "LG-4817" or a uuid; null = nothing selected. */
  ticketRef: string | null;
  /** The ticket's list row, if loaded: the header renders from it while the detail loads. */
  summary?: AnyTicketDto;
  /** "← Back to list" in the single-pane layout. */
  onBack: () => void;
  /** Move focus to the subject when the conversation opens (single-pane layout). */
  focusOnOpen?: boolean;
}

/** The selected ticket's conversation, or the "select a ticket" / not-found / loading states. */
export function ConversationPane({
  ticketRef,
  summary,
  onBack,
  focusOnOpen,
}: ConversationPaneProps) {
  const t = useTranslations('console');
  const detail = useTicket(ticketRef);

  if (!ticketRef) {
    return (
      <div className="grid h-full place-items-center p-10 text-center text-ink-muted">
        <p>{t('inbox.selectTicket')}</p>
      </div>
    );
  }

  if (detail.isError && (!detail.data || isNotFound(detail.error))) {
    const notFound = isNotFound(detail.error);
    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          title={notFound ? t('ticket.notFoundTitle') : t('ticket.loadFailed')}
          description={notFound ? t('ticket.notFound') : undefined}
          action={
            notFound ? (
              <Button type="button" variant="outline" onClick={onBack}>
                {t('ticket.backToList')}
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => void detail.refetch()}>
                {t('ticket.retry')}
              </Button>
            )
          }
        />
      </div>
    );
  }

  const ticket = detail.data ?? summary;
  if (!ticket) return <ConversationSkeleton />;

  return (
    <motion.div
      key={ticket.id}
      variants={fadeVariants}
      initial="hidden"
      animate="visible"
      className="h-full min-h-0"
    >
      <Conversation
        ticket={ticket}
        detail={detail.data}
        onBack={onBack}
        focusOnOpen={focusOnOpen}
      />
    </motion.div>
  );
}

function isNotFound(error: unknown): boolean {
  return isApiRequestError(error) && error.status === 404;
}

interface ConversationProps {
  ticket: AnyTicketDto;
  detail: TicketDetailDto | undefined;
  onBack: () => void;
  focusOnOpen?: boolean;
}

function Conversation({ ticket, detail, onBack, focusOnOpen }: ConversationProps) {
  const t = useTranslations('console.ticket');
  const headingId = useId();
  const [mode, setMode] = useState<ComposerMode>('public');
  const messages = useMessages(ticket.id);
  const sender = useSendMessage(ticket.id);
  const typing = useTyping(ticket.id, { scope: mode === 'internal' ? 'internal' : 'public' });
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Follow new messages while the agent is at (or near) the end of the thread.
  const stickToEnd = useRef(true);
  useTicketRoom(ticket.id);

  useEffect(() => {
    if (focusOnOpen) heading.current?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  const count = messages.data?.length ?? 0;
  const typingCount = typing.typingUsers.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [count, typingCount]);

  return (
    <div className="@container/ticket h-full min-h-0">
      <div
        className={cn(
          'flex h-full flex-col overflow-y-auto',
          '@min-[700px]/ticket:flex-row @min-[700px]/ticket:overflow-hidden',
        )}
      >
        <section
          aria-labelledby={headingId}
          className={cn(
            'flex min-h-full min-w-0 shrink-0 flex-col',
            '@min-[700px]/ticket:min-h-0 @min-[700px]/ticket:flex-[1_1_420px]',
          )}
        >
          <ConversationHeader
            ticket={ticket}
            onBack={onBack}
            headingRef={heading}
            headingId={headingId}
          />
          {/* The thread scrolls on its own from 700 px: a named, focusable region, so keyboard
              users can reach and scroll it even when no message contains a focusable element
              (axe scrollable-region-focusable; UI-RR-3). Its focus indicator is an inset outline
              on an overlay of the (non-scrolling) wrapper: drawn above the message bubbles (a
              ring on the scroller is painted under them) and kept in forced-colors mode, where
              box-shadow rings are dropped. */}
          <div
            className={cn(
              'relative flex flex-1 flex-col @min-[700px]/ticket:min-h-0',
              'after:pointer-events-none after:absolute after:inset-0',
              'has-[>:focus-visible]:after:outline-2 has-[>:focus-visible]:after:-outline-offset-2 has-[>:focus-visible]:after:outline-brand',
            )}
          >
            <div
              ref={scroller}
              role="region"
              aria-label={t('conversation')}
              tabIndex={0}
              onScroll={(event) => {
                const el = event.currentTarget;
                stickToEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className={cn(
                'flex flex-1 flex-col bg-surface-muted px-[26px] pt-[22px] pb-5 outline-none',
                '@min-[700px]/ticket:min-h-0 @min-[700px]/ticket:overflow-y-auto',
              )}
            >
              {/* The scroller is the named region: the thread adds no second "Conversation". */}
              <TicketThread
                messages={messages.data}
                isLoading={messages.isPending}
                isError={messages.isError}
                onReload={() => void messages.refetch()}
                onRetry={sender.retry}
                onDiscard={sender.discard}
                typingUsers={typing.typingUsers}
                gap="console"
                labelled={false}
              />
            </div>
          </div>
          <div className="shrink-0 bg-surface-muted px-[26px] pb-[22px]">
            {ticket.status === 'CLOSED' ? (
              <p className="rounded-xl border border-line bg-surface px-4 py-3.5 text-ink-muted">
                {t('closed')}
              </p>
            ) : (
              <Composer
                ticket={ticket}
                mode={mode}
                onModeChange={setMode}
                sender={sender}
                onTyping={typing.notifyTyping}
                onStopTyping={typing.stopTyping}
                onSent={() => {
                  stickToEnd.current = true;
                }}
              />
            )}
          </div>
        </section>
        <aside
          aria-label={t('details')}
          className={cn(
            'min-w-0 border-t border-line bg-surface px-[22px] pt-[22px] pb-[30px]',
            '@min-[700px]/ticket:max-w-[400px] @min-[700px]/ticket:flex-[1_1_280px] @min-[700px]/ticket:overflow-y-auto @min-[700px]/ticket:border-t-0 @min-[700px]/ticket:border-s',
          )}
        >
          {detail ? <TicketPanel ticket={detail} /> : <PanelSkeleton />}
        </aside>
      </div>
    </div>
  );
}

function PanelSkeleton() {
  const t = useTranslations('console.ticket');
  return (
    <LoadingRegion label={t('loadingDetails')} className="flex flex-col gap-[22px]">
      <Skeleton className="h-[118px] rounded-xl" />
      <div className="flex flex-col gap-2.5">
        <SkeletonText className="w-14" />
        <Skeleton className="h-9 rounded-lg" />
      </div>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-3.5">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="contents">
            <SkeletonText className="w-16" />
            <SkeletonText className={i % 2 ? 'w-2/3' : 'w-4/5'} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/** Loading state before anything about the ticket is known (deep link, not in the list). */
export function ConversationSkeleton() {
  const t = useTranslations('console.ticket');
  return (
    <LoadingRegion label={t('loading')} className="flex h-full flex-col">
      <div className="flex flex-col gap-2.5 border-b border-line px-[26px] py-[18px]">
        <SkeletonText className="w-3/5" />
        <Skeleton className="h-6 w-4/5 rounded-sm" />
        <SkeletonText className="w-20" />
      </div>
      <div className="flex flex-1 flex-col gap-5 bg-surface-muted px-[26px] py-[22px]">
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <SkeletonText className="w-32" />
              <Skeleton className={cn('h-16 rounded-lg', i ? 'w-3/5' : 'w-4/5')} />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
