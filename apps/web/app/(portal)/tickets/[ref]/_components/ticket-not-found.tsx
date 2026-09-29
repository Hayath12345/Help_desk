import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { BackLink } from './back-link';

/**
 * Unknown ticket, or one this client may not see (the API answers 404 for both, so the page
 * never reveals that a ticket exists). Same look as the shared EmptyState, with the page's h1.
 * Server-compatible: used by not-found.tsx and by the client page when the API says 404.
 */
export function TicketNotFound() {
  const t = useTranslations('portal.ticket');
  return (
    <div className="flex flex-col gap-[18px]">
      <BackLink />
      <Card className="items-center gap-2.5 px-5 py-12 text-center">
        <span
          aria-hidden="true"
          className="mb-1 grid size-10 place-items-center rounded-full bg-surface-sunken text-ink-muted [&_svg]:size-5"
        >
          <SearchX />
        </span>
        <h1 className="text-base font-semibold text-ink">{t('notFoundTitle')}</h1>
        <p className="max-w-md text-balance text-ink-muted">{t('notFoundDescription')}</p>
        <Button asChild variant="outline" className="mt-1.5">
          <Link href="/tickets" className="text-ink no-underline hover:text-ink">
            {t('back')}
          </Link>
        </Button>
      </Card>
    </div>
  );
}
