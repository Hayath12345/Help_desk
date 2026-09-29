import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** "← All tickets" (design 638); the arrow points the other way in Arabic. */
export function BackLink() {
  const t = useTranslations('portal.ticket');
  return (
    <Link
      href="/tickets"
      className="inline-flex items-center gap-1.5 self-start rounded-sm text-ink-muted no-underline transition-colors duration-150 hover:text-ink"
    >
      <ArrowLeft aria-hidden="true" className="size-4 rtl:rotate-180" />
      {t('back')}
    </Link>
  );
}
