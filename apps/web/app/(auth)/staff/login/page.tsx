import { WEB_ROUTES } from '@loons/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { DevHint } from '@/components/auth/dev-hint';
import { FormError } from '@/components/auth/form-message';
import { LoginForm } from '@/components/auth/login-form';
import { MicrosoftSignInButton } from '@/components/auth/oauth-buttons';
import { SwitchCard } from '@/components/auth/switch-card';
import { firstParam, safeCallbackUrl } from '@/lib/auth/callback-url';
import { isDevStaffLoginEnabled, isEntraConfigured } from '@/lib/auth/env';
import { resolveAuthErrorKey } from '@/lib/auth/errors';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.staffLogin');
  return { title: t('metaTitle') };
}

export default async function StaffLoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const t = await getTranslations('auth');
  const tErrors = await getTranslations('errors');
  const callbackUrl = safeCallbackUrl(firstParam(params.callbackUrl));
  const urlError = resolveAuthErrorKey(firstParam(params.error), firstParam(params.code));

  const entraEnabled = isEntraConfigured();
  const devLoginEnabled = !entraEnabled && isDevStaffLoginEnabled();

  return (
    <>
      <AuthCard aria-labelledby="staff-login-title">
        <AuthCardHeader
          titleId="staff-login-title"
          title={t('staffLogin.title')}
          subtitle={t('staffLogin.subtitle')}
        />
        {entraEnabled ? (
          <>
            <FormError>{urlError ? tErrors(urlError) : null}</FormError>
            <MicrosoftSignInButton callbackUrl={callbackUrl} />
          </>
        ) : devLoginEnabled ? (
          <>
            <p className="rounded-md border border-dashed border-line-dashed bg-surface-muted px-2.5 py-2 text-[13px] leading-normal text-ink-muted">
              {t('staffLogin.devNote')}
            </p>
            <LoginForm audience="staff" callbackUrl={callbackUrl} initialError={urlError} />
          </>
        ) : (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-md bg-surface-sunken px-3 py-2.5 text-[13px] leading-normal"
          >
            <p className="font-medium text-ink">{t('staffLogin.notConfiguredTitle')}</p>
            <p className="text-ink-muted">{t('staffLogin.notConfigured')}</p>
          </div>
        )}
      </AuthCard>
      <SwitchCard
        kicker={t('staffLogin.switchKicker')}
        text={t('staffLogin.switchText')}
        href={WEB_ROUTES.clientLogin}
        action={t('staffLogin.switchAction')}
      />
      <DevHint />
    </>
  );
}
