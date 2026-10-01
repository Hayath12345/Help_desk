import { describe, expect, it } from 'vitest';
import { helpArticleLanguage, helpArticlesQuerySchema } from './help.ts';

// Help center language rule (E15 / Phase 5 F13), shared by the admin preview and GET
// /help/articles: Arabic only when both the Arabic title and the Arabic text exist.

describe('helpArticleLanguage', () => {
  const both = { titleAr: 'عنوان', bodyAr: 'نص' };

  it('English readers always get English', () => {
    expect(helpArticleLanguage('en', both)).toBe('en');
    expect(helpArticleLanguage('en', { titleAr: '', bodyAr: '' })).toBe('en');
  });

  it('Arabic readers get Arabic only when the title and the text both exist', () => {
    expect(helpArticleLanguage('ar', both)).toBe('ar');
    expect(helpArticleLanguage('ar', { titleAr: 'عنوان', bodyAr: '' })).toBe('en');
    expect(helpArticleLanguage('ar', { titleAr: '', bodyAr: 'نص' })).toBe('en');
    // Blank (whitespace only) counts as missing.
    expect(helpArticleLanguage('ar', { titleAr: '  ', bodyAr: 'نص' })).toBe('en');
    expect(helpArticleLanguage('ar', { titleAr: 'عنوان', bodyAr: '\n\t ' })).toBe('en');
  });

  it('the query defaults to English and takes en | ar only', () => {
    expect(helpArticlesQuerySchema.parse({})).toEqual({ locale: 'en' });
    expect(helpArticlesQuerySchema.parse({ locale: 'ar' })).toEqual({ locale: 'ar' });
    expect(helpArticlesQuerySchema.safeParse({ locale: 'fr' }).success).toBe(false);
  });
});
