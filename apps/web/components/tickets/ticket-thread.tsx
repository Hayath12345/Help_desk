'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTextDirection } from '@/hooks/use-text-direction';
import { messageVariants } from '@/lib/motion';
import type { TypingUser } from '@/lib/realtime/hooks';
import type { ThreadMessage } from '@/lib/tickets/types';
import { cn } from '@/lib/utils';
import { MessageBubble } from './message-bubble';
import { TypingIndicator } from './typing-indicator';

export interface TicketThreadProps {
  /** From `useMessages(ticketId).data` (includes optimistic messages). */
  messages: readonly ThreadMessage[] | undefined;
  isLoading?: boolean;
  isError?: boolean;
  /** Shown with a "Try again" button when loading failed. */
  onReload?: () => void;
  onRetry?: (message: ThreadMessage) => void;
  onDiscard?: (message: ThreadMessage) => void;
  /** `useTyping(ticketId).typingUsers`; renders "… is typing" under the last message. */
  typingUsers?: readonly TypingUser[];
  /** Replaces the default "No messages yet." */
  emptyText?: React.ReactNode;
  /** Gap between messages: 18px in the portal, 20px in the console (design). */
  gap?: 'portal' | 'console';
  /**
   * The thread is a region landmark named "Conversation" (default). Pass false when a container
   * already is that named region (the console's focusable scroller), so there is one landmark
   * with that name, not two nested ones (axe landmark-unique; UI-RR-3).
   */
  labelled?: boolean;
  className?: string;
}

function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <SkeletonText className="w-28" />
              <SkeletonText className="w-14" />
            </div>
            <Skeleton className={cn('h-16 rounded-lg', i === 0 ? 'w-4/5' : 'w-3/5')} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The conversation (design 650–660 portal, 782–792 console): messages in order, new ones slide
 * in from the inline-start side (mirrored in RTL; reduced motion keeps only the fade), skeletons
 * while loading, pending / failed optimistic messages, and the typing indicator. It is a `log`
 * region, so screen readers announce new messages.
 */
export function TicketThread({
  messages,
  isLoading = false,
  isError = false,
  onReload,
  onRetry,
  onDiscard,
  typingUsers,
  emptyText,
  gap = 'portal',
  labelled = true,
  className,
}: TicketThreadProps) {
  const t = useTranslations('tickets.thread');
  const dir = useTextDirection();
  const variants = messageVariants(dir);

  if (isLoading && !messages) {
    return (
      <LoadingRegion label={t('loading')} className={className}>
        <ThreadSkeleton />
      </LoadingRegion>
    );
  }

  if (isError && !messages) {
    return (
      <div className={cn('flex flex-col items-start gap-2 text-ink-muted', className)}>
        <p role="alert">{t('loadFailed')}</p>
        {onReload ? (
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            {t('retryLoad')}
          </Button>
        ) : null}
      </div>
    );
  }

  const list = messages ?? [];
  const Root = labelled ? 'section' : 'div';

  return (
    <Root aria-label={labelled ? t('label') : undefined} className={cn('flex flex-col', className)}>
      <div role="log" aria-live="polite" aria-relevant="additions">
        {list.length === 0 ? (
          <p className="text-ink-muted">{emptyText ?? t('empty')}</p>
        ) : (
          <ol className={cn('flex flex-col', gap === 'console' ? 'gap-5' : 'gap-[18px]')}>
            <AnimatePresence initial={false}>
              {list.map((message) => (
                <motion.li
                  key={message.clientTempId ?? message.id}
                  layout="position"
                  variants={variants}
                  initial="hidden"
                  animate="visible"
                >
                  <MessageBubble message={message} onRetry={onRetry} onDiscard={onDiscard} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>
      {typingUsers ? <TypingIndicator users={typingUsers} className="mt-3" /> : null}
    </Root>
  );
}
