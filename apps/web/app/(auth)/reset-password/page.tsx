import { WEB_ROUTES } from '@loons/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { DevHint } from '@/components/auth/dev-hint';
import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { primaryButtonClass } from '@/components/auth/styles';
import { firstParam } from '@/lib/auth/callback-url';
import { cn } from '@/lib/utils';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Same bounds as the API's resetPasswordSchema token (32 random bytes, base64url). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.reset');
  return { title: t('metaTitle'), referrer: 'no-referrer' };
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const t = await getTranslations('auth.reset');
  const token = firstParam(params.token)?.trim() ?? '';
  const validShape = TOKEN_PATTERN.test(token);

  return (
    <>
      <AuthCard aria-labelledby="reset-title">
        {validShape ? (
          <>
            <AuthCardHeader titleId="reset-title" title={t('title')} subtitle={t('subtitle')} />
            <ResetPasswordForm token={token} />
          </>
        ) : (
          <>
            <AuthCardHeader
              titleId="reset-title"
              title={t('invalidTitle')}
              subtitle={t('invalidBody')}
            />
            <Link
              href={WEB_ROUTES.forgotPassword}
              className={cn(
                primaryButtonClass,
                'inline-flex items-center justify-center text-primary-foreground hover:text-primary-foreground',
              )}
            >
              {t('requestNew')}
            </Link>
            <Link
              href={WEB_ROUTES.clientLogin}
              className="text-center text-[13px] text-brand-ink hover:text-ink"
            >
              {t('back')}
            </Link>
          </>
        )}
      </AuthCard>
      <DevHint />
    </>
  );
}
