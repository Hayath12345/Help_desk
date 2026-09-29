'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatNumber } from '@/lib/format';
import type { TypingUser } from '@/lib/realtime/hooks';
import { cn } from '@/lib/utils';

/** The sentence for who is typing, or null when nobody is. */
export function useTypingText(users: readonly TypingUser[]): string | null {
  const t = useTranslations('tickets.typing');
  const locale = useLocale();
  const [first, second] = users;
  if (!first) return null;
  if (users.length === 1) {
    return first.scope === 'internal'
      ? t('note', { name: first.name })
      : t('one', { name: first.name });
  }
  if (users.length === 2 && second) return t('two', { first: first.name, second: second.name });
  return t('many', { n: formatNumber(users.length, locale) });
}

/**
 * "Maya is typing…" under a thread. The live region stays mounted (empty when nobody types) so
 * screen readers announce changes politely. Feed it `useTyping(ticketId).typingUsers`.
 */
export function TypingIndicator({
  users,
  className,
}: {
  users: readonly TypingUser[];
  className?: string;
}) {
  const text = useTypingText(users);
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className={cn('flex min-h-5 items-center gap-2 text-[13px] text-ink-muted', className)}
    >
      {text ? (
        <>
          <span aria-hidden="true" className="inline-flex items-center gap-[3px]">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="size-1 animate-pulse rounded-full bg-ink-muted"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span>{text}</span>
        </>
      ) : null}
    </div>
  );
}
