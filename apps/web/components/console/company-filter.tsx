'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Strip under the list header of the Inbox company view (Phase 5 F9): says that the list holds
 * every ticket of the company (solved ones included, unlike the views) and offers a "Clear" chip
 * back to the view it replaced. The chip is a link (it can open in a new tab); a plain click is
 * handled in place by `onClear`.
 */
export function CompanyFilter({
  href,
  onClear,
}: {
  href: string;
  onClear: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const t = useTranslations('console.inbox.company');
  return (
    <div className="flex items-center justify-between gap-3 border-b border-divider px-5 py-2.5">
      <p className="min-w-0 text-[13px] text-ink-muted">{t('note')}</p>
      <a
        href={href}
        onClick={onClear}
        aria-label={t('clearLabel')}
        data-company-clear=""
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface py-1 ps-2 pe-2.5 text-[13px] text-ink-secondary no-underline transition-colors duration-150 ease-out hover:border-brand-border hover:text-ink"
      >
        <X aria-hidden="true" className="size-3.5" />
        {t('clear')}
      </a>
    </div>
  );
}
