'use client';

import { useTranslations } from 'next-intl';
import { signOutAction } from '@/app/actions/auth';
import { clearApiToken } from '@/lib/api/browser';
import { SubmitButton } from './submit-button';

/**
 * Sign-out as a form (works without JavaScript). Drops the browser's cached API token first so
 * the next user in this tab can never reuse it.
 */
export function SignOutButton({
  appearance = 'outline',
  className,
  label,
}: {
  appearance?: 'primary' | 'outline';
  className?: string;
  label?: string;
}) {
  const t = useTranslations('common');
  return (
    <form action={signOutAction} onSubmit={() => clearApiToken()}>
      <SubmitButton appearance={appearance} className={className}>
        {label ?? t('signOut')}
      </SubmitButton>
    </form>
  );
}
