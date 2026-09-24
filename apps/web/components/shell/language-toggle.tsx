'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setLocaleAction } from '@/app/actions/locale';
import { cn } from '@/lib/utils';

/**
 * Bordered 13px button showing the *other* language's name ("العربية" / "English"), as in the
 * design. The server action sets the cookie and re-renders the page in the new language.
 *
 * Accessibility: the accessible name is the visible language name (label-in-name), marked with its
 * own `lang` so screen readers pronounce it; "Switch language" is the description (tooltip). While
 * the switch is pending the button is `aria-disabled`, not `disabled`: disabling the focused
 * button would drop keyboard focus to <body>. The button stays mounted across the switch, so focus
 * stays on it in the new language.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const t = useTranslations('common');
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const next = locale === 'ar' ? 'en' : 'ar';

  return (
    <button
      type="button"
      onClick={() => {
        if (pending) return;
        startTransition(async () => {
          await setLocaleAction(next);
        });
      }}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      title={t('switchLanguage')}
      className={cn(
        // Padding, not a fixed height: 6px + the line box + 6px, like the design (31px for
        // "English", 33px for "العربية", whose Arabic font has a taller line box).
        'inline-flex shrink-0 cursor-pointer items-center rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-ink transition-[background-color,opacity] duration-150 ease-out hover:bg-surface-sunken aria-disabled:cursor-progress aria-disabled:opacity-60',
        className,
      )}
    >
      <span lang={next}>{t('languageLabel')}</span>
    </button>
  );
}
