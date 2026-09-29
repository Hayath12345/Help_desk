'use client';

import { isStaffRole } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { InitialsAvatar } from '@/components/common/initials-avatar';
import { formatDateTime, initialsFrom } from '@/lib/format';
import type { ThreadMessage } from '@/lib/tickets/types';
import { cn } from '@/lib/utils';
import { AttachmentChips } from './attachment-chips';
import { linkify } from './linkify';

export type MessageKind = 'client' | 'support' | 'internal' | 'system';

/** Client / Loons Support / Internal note / System — decides the tag, avatar and bubble colours. */
export function messageKind(message: Pick<ThreadMessage, 'type' | 'author'>): MessageKind {
  if (message.type === 'SYSTEM') return 'system';
  if (message.type === 'INTERNAL') return 'internal';
  return message.author && isStaffRole(message.author.role) ? 'support' : 'client';
}

const TAG_TONE: Record<Exclude<MessageKind, 'system'>, string> = {
  client: 'bg-divider text-ink-secondary',
  support: 'bg-brand-tint text-brand-ink',
  internal: 'bg-note-tag text-note-ink',
};

const AVATAR_VARIANT = { client: 'track', support: 'brand-soft', internal: 'note' } as const;

/** Message body: preserved line breaks, URLs as safe links (never raw HTML). */
export function MessageBody({ body, className }: { body: string; className?: string }) {
  const t = useTranslations('tickets.thread');
  return (
    // dir="auto": an English message reads left-to-right inside the Arabic UI and vice versa.
    <div
      dir="auto"
      className={cn(
        'text-start text-[15px] leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]',
        className,
      )}
    >
      {linkify(body).map((part, index) =>
        part.kind === 'link' ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="text-brand-ink underline underline-offset-2 hover:text-ink"
          >
            {part.text}
            <span className="sr-only"> {t('newTab')}</span>
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}

export interface MessageBubbleProps {
  message: ThreadMessage;
  /** Failed optimistic message → "Retry" (from `useSendMessage().retry`). */
  onRetry?: (message: ThreadMessage) => void;
  /** Failed optimistic message → "Discard" (from `useSendMessage().discard`). */
  onDiscard?: (message: ThreadMessage) => void;
  className?: string;
}

/**
 * One thread entry (design 651–659): avatar, author, role tag (Client / Loons Support /
 * Internal note), time, the bubble (yellow for internal notes) and attachment chips. Optimistic
 * messages show "Sending…" (pending) or "Not sent · Retry · Discard" (failed). SYSTEM messages
 * render as a quiet centred line.
 */
export function MessageBubble({ message, onRetry, onDiscard, className }: MessageBubbleProps) {
  const t = useTranslations('tickets');
  const locale = useLocale();
  const kind = messageKind(message);
  const time = formatDateTime(message.createdAt, locale);
  const status = message.local?.status;

  if (kind === 'system') {
    return (
      <div
        className={cn(
          'flex items-center justify-center gap-2 px-2 text-center text-[13px] text-ink-muted',
          className,
        )}
      >
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.body}</span>
        <time dateTime={message.createdAt} className="font-mono text-xs whitespace-nowrap">
          {time}
        </time>
      </div>
    );
  }

  const authorName = message.author?.name ?? t('thread.formerUser');
  const tag = t(`role.${kind}`);

  return (
    <article
      data-kind={kind}
      data-status={status}
      aria-busy={status === 'pending' || undefined}
      className={cn('flex gap-3', className)}
    >
      <InitialsAvatar
        initials={initialsFrom(authorName) || '?'}
        variant={AVATAR_VARIANT[kind]}
        size="md"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex flex-wrap items-center gap-2">
          <span className="font-semibold whitespace-nowrap text-ink">{authorName}</span>
          <span
            className={cn('rounded-[5px] px-[7px] py-px text-xs whitespace-nowrap', TAG_TONE[kind])}
          >
            {tag}
          </span>
          <time
            dateTime={message.createdAt}
            className="font-mono text-xs whitespace-nowrap text-ink-muted"
          >
            {time}
          </time>
        </header>
        <div
          className={cn(
            'rounded-lg border px-4 py-3 text-ink transition-[opacity,border-color] duration-200 ease-out',
            kind === 'internal' ? 'border-note-border bg-note-bg' : 'border-line bg-surface',
            status === 'pending' && 'opacity-70',
            status === 'failed' && 'border-danger-strong',
          )}
        >
          <MessageBody body={message.body} />
        </div>
        <AttachmentChips attachments={message.attachments} />
        {status === 'pending' ? (
          <p className="text-xs text-ink-muted">{t('thread.sending')}</p>
        ) : null}
        {status === 'failed' ? (
          <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-danger">{t('thread.failed')}</span>
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(message)}
                className="cursor-pointer font-medium text-brand-ink underline-offset-2 hover:underline"
              >
                {t('thread.retry')}
              </button>
            ) : null}
            {onDiscard ? (
              <button
                type="button"
                onClick={() => onDiscard(message)}
                className="cursor-pointer text-ink-muted underline-offset-2 hover:text-ink hover:underline"
              >
                {t('thread.discard')}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </article>
  );
}
