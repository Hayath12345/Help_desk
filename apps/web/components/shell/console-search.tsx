'use client';

import type { Route } from 'next';
import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { INBOX_PATH, SEARCH_MAX, inboxHref, updateInboxUrl } from '@/components/console/inbox-url';
import { QUEUE_PATH, updateQueueUrl } from '@/lib/queue/url';
import { cn } from '@/lib/utils';

interface ConsoleSearchState {
  query: string;
  setQuery: (query: string) => void;
  /** Applies the query at once (Enter / clear) instead of after the typing pause. */
  submit: (query?: string) => void;
}

const ConsoleSearchContext = createContext<ConsoleSearchState | null>(null);

/** Typing pause before the inbox URL (and so the ticket list query) follows the box. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The console's ticket search. The box in the top bar is the inbox's `?q=`:
 * - on /console/inbox, typing updates `q` (History API replace, after a short pause) and drops
 *   `ticket`, so the list refilters in place; Back / Forward and links update the box;
 * - on /console/queue the box is the Team queue's `?q=` the same way: the queue filters in place
 *   (Phase 5 F4; its tab and filters stay);
 * - on the other console pages, searching opens the inbox's "All open" view with that query
 *   (design: searching from Customers / Reports jumps to the inbox).
 */
export function ConsoleSearchProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const onInbox = pathname === INBOX_PATH;
  const onQueue = pathname === QUEUE_PATH;
  const urlQuery = onInbox || onQueue ? (searchParams?.get('q') ?? '').slice(0, SEARCH_MAX) : '';

  // What the box shows. `synced` is the URL value it was last aligned with: when the URL
  // changes by itself (Back, a link, the view select), the box follows it.
  const [text, setText] = useState(urlQuery);
  const [synced, setSynced] = useState(urlQuery);
  if (synced !== urlQuery) {
    setSynced(urlQuery);
    if (text.trim() !== urlQuery) setText(urlQuery);
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const apply = useCallback(
    (value: string) => {
      const q = value.trim().slice(0, SEARCH_MAX);
      if (onInbox) {
        updateInboxUrl({ q, ticket: null }, 'replace');
      } else if (onQueue) {
        updateQueueUrl({ q }, 'replace');
      } else if (q) {
        router.push(inboxHref({ view: 'open', q }) as Route);
      }
    },
    [onInbox, onQueue, router],
  );

  const setQuery = useCallback(
    (value: string) => {
      setText(value);
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        apply(value);
      }, SEARCH_DEBOUNCE_MS);
    },
    [apply],
  );

  const submit = useCallback(
    (value?: string) => {
      const next = value ?? text;
      if (value !== undefined) setText(value);
      cancel();
      apply(next);
    },
    [apply, text],
  );

  const value = useMemo(() => ({ query: text, setQuery, submit }), [text, setQuery, submit]);
  return <ConsoleSearchContext.Provider value={value}>{children}</ConsoleSearchContext.Provider>;
}

/** Current console search (a no-op store outside a provider). */
export function useConsoleSearch(): ConsoleSearchState {
  const ctx = useContext(ConsoleSearchContext);
  return ctx ?? { query: '', setQuery: () => {}, submit: () => {} };
}

/**
 * Design 684–690: muted rounded box with a search glyph, the input and a clear button. The
 * placeholder is the box's only visible label and × is a control, so both use ink-muted (4.6:1 on
 * surface-muted) rather than the design's ink-subtle (2.5:1); the glyph matches them.
 */
export function ConsoleSearchBox({ className }: { className?: string }) {
  const t = useTranslations('console.search');
  const { query, setQuery, submit } = useConsoleSearch();
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      role="search"
      aria-label={t('label')}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-muted px-2.5 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-brand focus-within:ring-3 focus-within:ring-brand-tint focus-within:outline-hidden',
        className,
      )}
    >
      <Search aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
      <input
        ref={input}
        type="search"
        value={query}
        maxLength={SEARCH_MAX}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape' && query) {
            event.preventDefault();
            submit('');
          }
        }}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-muted [&::-webkit-search-cancel-button]:appearance-none"
      />
      {query ? (
        <button
          type="button"
          onClick={() => {
            submit('');
            input.current?.focus();
          }}
          aria-label={t('clear')}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-muted transition-colors hover:text-ink"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
