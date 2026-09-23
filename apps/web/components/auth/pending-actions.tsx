'use client';

import { useTranslations } from 'next-intl';
import { refreshSessionAction } from '@/app/actions/auth';
import { SignOutButton } from './sign-out-button';
import { SubmitButton } from './submit-button';

/** "Check again" (re-reads the account from the API now) and "Sign out". */
export function PendingActions() {
  const t = useTranslations('auth.pending');
  return (
    <div className="flex flex-col gap-2.5">
      <form action={refreshSessionAction}>
        <SubmitButton>{t('checkAgain')}</SubmitButton>
      </form>
      <SignOutButton label={t('signOut')} />
    </div>
  );
}
