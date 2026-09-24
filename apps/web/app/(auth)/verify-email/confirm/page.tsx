import { WEB_ROUTES } from '@loons/shared';
import type { Metadata, Route } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { ConfirmEmailForm } from '@/components/auth/confirm-email-form';
import { primaryButtonClass } from '@/components/auth/styles';
import { firstParam } from '@/lib/auth/callback-url';
import { isEmailLinkToken } from '@/lib/auth/forms';
import { getCurrentUser } from '@/lib/session';
import { cn } from '@/lib/utils';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.confirmEmail');
  // The token is in the URL: never leak it through the Referer header.
  return { title: t('metaTitle'), referrer: 'no-referrer' };
}

/**
 * Target of the link in the verification email (`/verify-email/confirm?token=…`). Public: it
 * works signed in or out. Nothing happens on GET; the address is confirmed by the button (POST).
 */
export default async function ConfirmEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, user, t] = await Promise.all([
    searchParams,
    getCurrentUser(),
    getTranslations('auth.confirmEmail'),
  ]);
  const token = firstParam(params.token)?.trim() ?? '';
  const requestNewHref = (user ? WEB_ROUTES.verifyEmail : WEB_ROUTES.clientLogin) as Route;

  if (!isEmailLinkToken(token)) {
    return (
      <AuthCard aria-labelledby="confirm-email-title">
        <AuthCardHeader
          titleId="confirm-email-title"
          title={t('invalidTitle')}
          subtitle={t('invalidBody')}
        />
        <Link
          href={requestNewHref}
          className={cn(
            primaryButtonClass,
            'inline-flex items-center justify-center text-primary-foreground hover:text-primary-foreground',
          )}
        >
          {t('requestNew')}
        </Link>
        {user ? null : (
          <Link
            href={WEB_ROUTES.clientLogin}
            className="text-center text-[13px] text-brand-ink hover:text-ink"
          >
            {t('back')}
          </Link>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard aria-labelledby="confirm-email-title">
      <AuthCardHeader titleId="confirm-email-title" title={t('title')} subtitle={t('subtitle')} />
      <ConfirmEmailForm token={token} requestNewHref={requestNewHref} />
    </AuthCard>
  );
}
