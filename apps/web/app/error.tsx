'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Logo } from '@/components/common/logo';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary. Server errors reach the client as a generic message plus a digest,
 * so only the digest is shown (users can quote it to support; it matches the server logs).
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations('common.error');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-7 bg-page px-5 py-10">
      <Logo size="lg" />
      <div
        role="alert"
        className="flex w-full max-w-[400px] flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-7 text-center shadow-card"
      >
        <h1 className="text-[22px] font-semibold text-ink">{t('title')}</h1>
        <p className="text-balance text-ink-muted">{t('description')}</p>
        {error.digest ? (
          <p className="font-mono text-xs text-ink-muted">
            {t('reference', { digest: error.digest })}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-center gap-2.5">
          <Button type="button" onClick={() => retry()}>
            {t('retry')}
          </Button>
          <Button asChild variant="outline">
            <Link href="/" className="no-underline hover:text-ink">
              {t('home')}
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
