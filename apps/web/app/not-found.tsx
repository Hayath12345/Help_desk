import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Kicker } from '@/components/common/kicker';
import { Logo } from '@/components/common/logo';
import { Button } from '@/components/ui/button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common.notFound');
  return { title: t('title') };
}

export default async function NotFound() {
  const t = await getTranslations('common.notFound');

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-7 bg-page px-5 py-10">
      <Logo size="lg" />
      <div className="flex w-full max-w-[400px] flex-col items-center gap-3 rounded-2xl border border-line bg-surface p-7 text-center shadow-card">
        <Kicker as="p">404</Kicker>
        <h1 className="text-[22px] font-semibold text-ink">{t('title')}</h1>
        <p className="text-balance text-ink-muted">{t('description')}</p>
        <Button asChild className="mt-2">
          <Link href="/" className="no-underline hover:text-primary-foreground">
            {t('home')}
          </Link>
        </Button>
      </div>
    </main>
  );
}
