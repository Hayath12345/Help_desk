'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setLocaleAction } from '@/app/actions/locale';
import { cn } from '@/lib/utils';

/**
 * Bordered 13px button showing the *other* language's name ("العربية" / "English"), as in the
 * design. The server action sets the cookie and re-renders the page in the new language.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useTranslations('common');
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const next = locale === 'ar' ? 'en' : 'ar';

  return (
    <button
      type="button"
      onClick={() =>
        startTransition(async () => {
          await setLocaleAction(next);
        })
      }
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={t('switchLanguage')}
      title={t('switchLanguage')}
      className={cn(
        'inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-line bg-surface px-2.5 text-[13px] font-medium whitespace-nowrap text-ink transition-[background-color,opacity] duration-150 ease-out hover:bg-surface-sunken disabled:cursor-progress disabled:opacity-60',
        className,
      )}
    >
      {t('languageLabel')}
    </button>
  );
}
