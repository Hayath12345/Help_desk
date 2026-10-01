// Phase 5 — Help center (decision F13): published articles for any signed-in user.
//
// GET /help/articles?locale=en|ar → PublishedHelpArticleList
// Plain text (no markdown or HTML): render as text with the line breaks kept. Live refresh on
// `config:updated` with scope `help-center` (and after a reconnect).

import { z } from 'zod';
import { LOCALES, type Locale } from '../enums.ts';

/**
 * The language a reader of `locale` gets an article in (E15 / F13): Arabic only when both the
 * Arabic title and the Arabic text exist (non-blank), otherwise English. Shared by the admin
 * preview and the portal (through the API), so they can't drift.
 */
export function helpArticleLanguage(
  locale: Locale,
  article: { titleAr: string; bodyAr: string },
): Locale {
  return locale === 'ar' && article.titleAr.trim() !== '' && article.bodyAr.trim() !== ''
    ? 'ar'
    : 'en';
}

export const helpArticlesQuerySchema = z.object({
  /** The reader's UI language (default English). */
  locale: z.enum(LOCALES).optional().default('en'),
});
export type HelpArticlesQuery = z.infer<typeof helpArticlesQuerySchema>;

/** A published article in the language `helpArticleLanguage` picked (set `lang` / `dir` from it). */
export const publishedHelpArticleSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  language: z.enum(LOCALES),
  title: z.string(),
  /** Plain text; paragraphs are separated by blank lines. */
  body: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type PublishedHelpArticle = z.infer<typeof publishedHelpArticleSchema>;

/** Published, active articles in the admin's order. */
export const publishedHelpArticleListSchema = z.object({
  locale: z.enum(LOCALES),
  items: z.array(publishedHelpArticleSchema),
});
export type PublishedHelpArticleList = z.infer<typeof publishedHelpArticleListSchema>;
