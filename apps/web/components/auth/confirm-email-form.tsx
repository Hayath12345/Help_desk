'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { confirmEmailAction } from '@/app/actions/auth';
import { initialAuthFormState, type AuthFormState } from '@/lib/auth/forms';
import { FormError, FormNotice } from './form-message';
import { SubmitButton } from './submit-button';

/**
 * The "Confirm" button of an emailed verification link. Confirming is a POST (server action):
 * mail scanners pre-fetch links with GET, and must not use up the single-use token.
 */
export function ConfirmEmailForm({
  token,
  requestNewHref,
}: {
  token: string;
  /** Where "Request a new link" goes: /verify-email when signed in, else /login. */
  requestNewHref: Route;
}) {
  const t = useTranslations('auth.confirmEmail');
  const tErrors = useTranslations('errors');
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    confirmEmailAction,
    initialAuthFormState,
  );

  if (state.status === 'success') {
    // Confirmed for another account than the one signed in on this browser.
    return (
      <FormNotice>
        {t.rich('confirmed', {
          email: state.email ?? '',
          strong: (chunks) => (
            <strong dir="ltr" className="font-medium">
              {chunks}
            </strong>
          ),
        })}
      </FormNotice>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-[18px]">
      <input type="hidden" name="token" value={token} />
      <FormError>
        {state.error ? (
          <>
            {tErrors(state.error)}
            {state.error === 'VERIFY_TOKEN_INVALID' ? (
              <>
                {' '}
                <Link href={requestNewHref} className="font-medium underline">
                  {t('requestNew')}
                </Link>
              </>
            ) : null}
          </>
        ) : null}
      </FormError>
      <SubmitButton pending={isPending} disabled={state.error === 'VERIFY_TOKEN_INVALID'}>
        {t('submit')}
      </SubmitButton>
    </form>
  );
}
