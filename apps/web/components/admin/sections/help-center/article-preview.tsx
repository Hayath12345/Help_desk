'use client';

import { useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import type { ContentLanguage } from '../../kit';

export interface ArticlePreviewProps {
  /** The language tab being edited. */
  language: ContentLanguage;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  isPublished: boolean;
}

/** Arabic readers get the English article while its Arabic title or text is empty. */
export function previewLanguage(
  language: ContentLanguage,
  article: Pick<ArticlePreviewProps, 'titleAr' | 'bodyAr'>,
): ContentLanguage {
  return language === 'ar' && article.titleAr.trim() !== '' && article.bodyAr.trim() !== ''
    ? 'ar'
    : 'en';
}

/**
 * The article as a client reads it in the portal's Help center (E15): the open accordion row of
 * the portal page (title, then the text with its line breaks), in the edited language.
 */
export function ArticlePreview(props: ArticlePreviewProps) {
  const t = useTranslations('admin-comms.helpCenter.preview');
  const shown = previewLanguage(props.language, props);
  const title = shown === 'ar' ? props.titleAr : props.titleEn;
  const body = shown === 'ar' ? props.bodyAr : props.bodyEn;
  const empty = title.trim() === '' && body.trim() === '';

  return (
    <section aria-labelledby="article-preview-title" className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <Kicker as="h3" id="article-preview-title">
          {t('title')}
        </Kicker>
        <p className="text-[13px] text-ink-muted">{t('description')}</p>
      </div>
      {props.language === 'ar' && shown === 'en' ? (
        <p
          role="note"
          className="rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-[13px] leading-normal text-ink-secondary"
        >
          {t('englishFallback')}
        </p>
      ) : null}
      {!props.isPublished ? (
        <p className="text-[13px] leading-normal text-ink-muted">{t('draft')}</p>
      ) : null}
      <div
        data-testid="article-preview"
        {...(empty ? {} : { lang: shown, dir: shown === 'ar' ? 'rtl' : 'ltr' })}
        className="overflow-hidden rounded-xl border border-line bg-surface"
      >
        {empty ? (
          <p className="p-5 text-ink-muted">{t('empty')}</p>
        ) : (
          <>
            <p className="px-5 pt-4 pb-2 text-[15px] font-medium break-words text-ink">{title}</p>
            <p className="px-5 pb-[18px] leading-relaxed break-words whitespace-pre-line text-ink-secondary">
              {body}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
