import { WEB_ROUTES } from '@loons/shared';
import type { Metadata, Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { PendingActions } from '@/components/auth/pending-actions';
import { firstParam } from '@/lib/auth/callback-url';
import { landingPathFor } from '@/lib/auth/routing';
import { getCurrentUser } from '@/lib/session';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.pending');
  return { title: t('metaTitle') };
}

/** Self-registered clients whose email domain matched no organisation wait here. */
export default async function PendingApprovalPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const user = await getCurrentUser();
  if (!user) redirect(WEB_ROUTES.clientLogin);
  // Active users go home; unverified clients confirm their email address first.
  const landing = landingPathFor(user);
  if (landing !== WEB_ROUTES.pendingApproval) redirect(landing as Route);

  const params = await searchParams;
  const t = await getTranslations('auth.pending');
  const checked = firstParam(params.checked) === '1';

  return (
    <AuthCard aria-labelledby="pending-title">
      <AuthCardHeader titleId="pending-title" title={t('title')} subtitle={t('body')} />
      {checked ? (
        <p
          role="status"
          className="rounded-md bg-surface-sunken px-2.5 py-2 text-[13px] leading-normal text-ink-secondary"
        >
          {t('stillPending')}
        </p>
      ) : null}
      <p className="text-[13px] text-ink-muted">
        {t.rich('signedInAs', {
          email: user.email,
          strong: (chunks) => (
            <strong dir="ltr" className="font-medium text-ink">
              {chunks}
            </strong>
          ),
        })}
      </p>
      <PendingActions />
    </AuthCard>
  );
}
