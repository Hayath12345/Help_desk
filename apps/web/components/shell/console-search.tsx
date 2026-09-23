'use client';

import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface ConsoleSearchState {
  query: string;
  setQuery: (query: string) => void;
}

const ConsoleSearchContext = createContext<ConsoleSearchState | null>(null);

/**
 * Holds the console's ticket search query so the top-bar box and the ticket lists share it.
 * Phase 1 keeps it client-side only; Phase 2 feeds it to the ticket list queries.
 */
export function ConsoleSearchProvider({ children }: { children: React.ReactNode }) {
  const [query, setQuery] = useState('');
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <ConsoleSearchContext.Provider value={value}>{children}</ConsoleSearchContext.Provider>;
}

/** Current console search query (empty string outside a provider). */
export function useConsoleSearch(): ConsoleSearchState {
  const ctx = useContext(ConsoleSearchContext);
  return ctx ?? { query: '', setQuery: () => {} };
}

/** Design 684–690: muted rounded box with a search glyph, the input and a clear button. */
export function ConsoleSearchBox({ className }: { className?: string }) {
  const t = useTranslations('console.search');
  const { query, setQuery } = useConsoleSearch();
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      role="search"
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface-muted px-2.5 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-brand focus-within:ring-3 focus-within:ring-brand-tint',
        className,
      )}
    >
      <Search aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
      <input
        ref={input}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.preventDefault();
            setQuery('');
          }
        }}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        autoComplete="off"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-subtle [&::-webkit-search-cancel-button]:appearance-none"
      />
      {query ? (
        <button
          type="button"
          onClick={() => {
            setQuery('');
            input.current?.focus();
          }}
          aria-label={t('clear')}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-subtle transition-colors hover:text-ink"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
