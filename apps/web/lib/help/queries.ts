'use client';

import type { Locale } from '@loons/shared';
import { useQuery } from '@tanstack/react-query';
import { isApiRequestError } from '@/lib/api/errors';
import { fetchHelpArticles } from './api';
import { helpKeys } from './keys';

/** Don't retry answers that won't change (401 / 403 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/**
 * The portal Help center's articles in the UI language (`['help', locale]`). Kept current by
 * `config:updated` with scope `help-center` and refetched after a reconnect (lib/realtime), so an
 * article published, edited or unpublished in admin shows without a reload.
 */
export function useHelpArticles(locale: Locale) {
  return useQuery({
    queryKey: helpKeys.articles(locale),
    queryFn: ({ signal }) => fetchHelpArticles(locale, signal),
    staleTime: 5 * 60_000,
    retry: retryTransient,
  });
}
