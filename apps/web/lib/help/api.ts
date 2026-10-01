// Fetcher of the portal Help center (docs/PHASE5_CONTRACT.md F13): GET /help/articles as the
// signed-in user through the browser `apiClient`, parsed with the shared contract outside production.

import {
  publishedHelpArticleListSchema,
  type Locale,
  type PublishedHelpArticleList,
} from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';

/**
 * Published, active articles in the admin's order, each in the language the reader of `locale`
 * gets it in (`language`: Arabic only when both its Arabic title and text exist, else English).
 */
export async function fetchHelpArticles(
  locale: Locale,
  signal?: AbortSignal,
): Promise<PublishedHelpArticleList> {
  const data = await apiClient.get<unknown>(withQuery('/help/articles', { locale }), { signal });
  return parseResponse(publishedHelpArticleListSchema, data);
}
