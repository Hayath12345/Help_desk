import { WEB_ROUTES } from '@loons/shared';
import type { Metadata, Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { VerifyEmailActions } from '@/components/auth/verify-email-actions';
import { firstParam } from '@/lib/auth/callback-url';
import { landingPathFor, needsEmailVerification } from '@/lib/auth/routing';
import { getCurrentUser } from '@/lib/session';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verifyEmail');
  return { title: t('metaTitle') };
}

/**
 * Signed-in clients who have not confirmed their email address wait here (right after sign-up,
 * and on every later sign-in until they click the emailed link).
 */
export default async function VerifyEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await getCurrentUser();
  if (!user) redirect(WEB_ROUTES.clientLogin);
  if (!needsEmailVerification(user)) redirect(landingPathFor(user) as Route);

  const params = await searchParams;
  const t = await getTranslations('auth.verifyEmail');
  const checked = firstParam(params.checked) === '1';

  return (
    <AuthCard aria-labelledby="verify-email-title">
      <AuthCardHeader
        titleId="verify-email-title"
        title={t('title')}
        subtitle={t.rich('body', {
          email: user.email,
          strong: (chunks) => (
            <strong dir="ltr" className="font-medium text-ink">
              {chunks}
            </strong>
          ),
        })}
      />
      {checked ? (
        <p
          role="status"
          className="rounded-md bg-surface-sunken px-2.5 py-2 text-[13px] leading-normal text-ink-secondary"
        >
          {t('notYet')}
        </p>
      ) : null}
      <VerifyEmailActions />
    </AuthCard>
  );
}
