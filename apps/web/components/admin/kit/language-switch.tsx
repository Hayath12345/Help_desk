'use client';

import { useTranslations } from 'next-intl';
import { SegmentedControl } from '@/components/tickets/segmented-control';
import { cn } from '@/lib/utils';

/** The language of translatable content being edited (not the UI language). */
export type ContentLanguage = 'en' | 'ar';

/** `lang` + `dir` for a control that holds text in `language`. */
export function contentLanguageProps(language: ContentLanguage) {
  return { lang: language, dir: language === 'ar' ? 'rtl' : 'ltr' } as const;
}

export interface LanguageSwitchProps {
  value: ContentLanguage;
  onValueChange: (value: ContentLanguage) => void;
  /** Default "Content language". */
  'aria-label'?: string;
  className?: string;
}

/**
 * English | العربية switch above a long-content form (E2: email templates, help articles). Each
 * option is written in its own language, like the owner's reference. A radiogroup: arrow keys move
 * and select (mirrored in RTL).
 */
export function LanguageSwitch({ value, onValueChange, className, ...aria }: LanguageSwitchProps) {
  const t = useTranslations('admin.kit');
  return (
    <SegmentedControl
      size="sm"
      aria-label={aria['aria-label'] ?? t('contentLanguage')}
      value={value}
      onValueChange={onValueChange}
      className={cn('w-fit flex-nowrap', className)}
      itemClassName="px-3"
      options={[
        { value: 'en', label: <span lang="en">{t('languages.en')}</span> },
        {
          value: 'ar',
          label: (
            <span lang="ar" dir="rtl">
              {t('languages.ar')}
            </span>
          ),
        },
      ]}
    />
  );
}

/** Small tag after a translatable field's label ("English" / "Arabic"), like the reference. */
export function LanguageTag({
  language,
  className,
}: {
  language: ContentLanguage;
  className?: string;
}) {
  const t = useTranslations('admin.kit.languageTag');
  return (
    <span
      data-slot="language-tag"
      className={cn(
        'inline-flex items-center rounded-sm border border-line bg-surface px-1.5 py-px align-middle text-[11px] font-normal text-ink-muted',
        className,
      )}
    >
      {t(language)}
    </span>
  );
}
