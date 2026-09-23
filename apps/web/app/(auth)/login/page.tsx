import { WEB_ROUTES } from '@loons/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { DevHint } from '@/components/auth/dev-hint';
import { LoginForm } from '@/components/auth/login-form';
import { GoogleSignInButton } from '@/components/auth/oauth-buttons';
import { OrDivider } from '@/components/auth/or-divider';
import { SwitchCard } from '@/components/auth/switch-card';
import { firstParam, safeCallbackUrl } from '@/lib/auth/callback-url';
import { isGoogleConfigured } from '@/lib/auth/env';
import { resolveAuthErrorKey } from '@/lib/auth/errors';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.login');
  return { title: t('metaTitle') };
}

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const t = await getTranslations('auth');
  const callbackUrl = safeCallbackUrl(firstParam(params.callbackUrl));
  const initialError = resolveAuthErrorKey(firstParam(params.error), firstParam(params.code));
  const notice = firstParam(params.reset) === '1' ? t('login.resetSuccess') : null;
  const googleEnabled = isGoogleConfigured();

  return (
    <>
      <AuthCard aria-labelledby="login-title">
        <AuthCardHeader
          titleId="login-title"
          title={t('login.title')}
          subtitle={t('login.subtitle')}
        />
        <LoginForm
          audience="client"
          callbackUrl={callbackUrl}
          initialError={initialError}
          notice={notice}
        />
        {googleEnabled ? (
          <>
            <OrDivider label={t('login.or')} />
            <GoogleSignInButton callbackUrl={callbackUrl} />
          </>
        ) : null}
        <p className="text-center text-[13px] text-ink-muted">
          {t('login.newHere')}{' '}
          <Link
            href={WEB_ROUTES.signup}
            className="whitespace-nowrap text-brand-ink hover:text-ink"
          >
            {t('login.createAccount')}
          </Link>
        </p>
      </AuthCard>
      <SwitchCard
        kicker={t('login.switchKicker')}
        text={t('login.switchText')}
        href={WEB_ROUTES.staffLogin}
        action={t('login.switchAction')}
      />
      <DevHint />
    </>
  );
}
