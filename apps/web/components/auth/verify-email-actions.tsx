'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { recheckEmailVerificationAction, resendVerificationEmailAction } from '@/app/actions/auth';
import { initialAuthFormState, type AuthFormState } from '@/lib/auth/forms';
import { FormError, FormNotice } from './form-message';
import { SignOutButton } from './sign-out-button';
import { SubmitButton } from './submit-button';

/**
 * /verify-email actions: "I've verified — continue" (reloads the account now), "Resend email"
 * (with a sent / rate-limited message) and "Sign out".
 */
export function VerifyEmailActions() {
  const t = useTranslations('auth.verifyEmail');
  const tErrors = useTranslations('errors');
  const [state, resendAction, isPending] = useActionState<AuthFormState, FormData>(
    resendVerificationEmailAction,
    initialAuthFormState,
  );

  return (
    <div className="flex flex-col gap-2.5">
      <FormNotice>
        {state.status === 'success'
          ? t.rich('resent', {
              email: state.email ?? '',
              strong: (chunks) => (
                <strong dir="ltr" className="font-medium">
                  {chunks}
                </strong>
              ),
            })
          : null}
      </FormNotice>
      <FormError>{state.error ? tErrors(state.error) : null}</FormError>
      <form action={recheckEmailVerificationAction}>
        <SubmitButton>{t('continue')}</SubmitButton>
      </form>
      <form action={resendAction}>
        <SubmitButton appearance="outline" pending={isPending}>
          {t('resend')}
        </SubmitButton>
      </form>
      <SignOutButton label={t('signOut')} />
    </div>
  );
}
