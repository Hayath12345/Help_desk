'use client';

// The cards of /verify-email/confirm (the link in the verification email). The address is only
// confirmed inside that account's own session (RR-SEC-1): its owner gets the Confirm button,
// anyone else is asked to sign in to that account first.

import { WEB_ROUTES, type ErrorCode } from '@loons/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef } from 'react';
import { confirmEmailAction, signOutToConfirmEmailAction } from '@/app/actions/auth';
import { clearApiToken } from '@/lib/api/browser';
import { initialAuthFormState, type AuthFormState } from '@/lib/auth/forms';
import { cn } from '@/lib/utils';
import { AuthCard, AuthCardHeader } from './auth-card';
import { FormError } from './form-message';
import { primaryButtonClass } from './styles';
import { SubmitButton } from './submit-button';

const TITLE_ID = 'confirm-email-title';
const INVALID_BODY_ID = 'confirm-email-invalid-body';

/** A link that looks like the primary button. */
const primaryLinkClass = cn(
  primaryButtonClass,
  'inline-flex items-center justify-center text-primary-foreground hover:text-primary-foreground',
);
const secondaryLinkClass = 'text-center text-[13px] text-brand-ink hover:text-ink';

/** An email address inside a sentence: always left-to-right, also in Arabic text. */
function strongAddress(chunks: React.ReactNode) {
  return (
    <strong dir="ltr" className="font-medium text-ink">
      {chunks}
    </strong>
  );
}

/**
 * "This link is invalid or has expired" + "Request a new link". With `focusLink` the link takes
 * keyboard focus when the card appears — used when it replaces the Confirm form after a submission,
 * so focus doesn't fall back to the page.
 */
export function InvalidEmailLinkCard({
  requestNewHref,
  signedIn,
  focusLink = false,
}: {
  /** /verify-email when signed in (it can resend), else /login. */
  requestNewHref: Route;
  signedIn: boolean;
  focusLink?: boolean;
}) {
  const t = useTranslations('auth.confirmEmail');
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (focusLink) linkRef.current?.focus();
  }, [focusLink]);

  return (
    <AuthCard aria-labelledby={TITLE_ID}>
      <AuthCardHeader
        titleId={TITLE_ID}
        title={t('invalidTitle')}
        subtitleId={INVALID_BODY_ID}
        subtitle={t('invalidBody')}
      />
      {/* Described by the title and body, so moving focus here also announces why. */}
      <Link
        ref={linkRef}
        href={requestNewHref}
        aria-describedby={`${TITLE_ID} ${INVALID_BODY_ID}`}
        className={primaryLinkClass}
      >
        {t('requestNew')}
      </Link>
      {signedIn ? null : (
        <Link href={WEB_ROUTES.clientLogin} className={secondaryLinkClass}>
          {t('back')}
        </Link>
      )}
    </AuthCard>
  );
}

/**
 * The link's own account is signed in: "Confirm" (a POST on purpose: mail scanners pre-fetch links
 * with GET and must not use up the single-use token).
 */
export function ConfirmEmailCard({
  token,
  requestNewHref,
}: {
  token: string;
  requestNewHref: Route;
}) {
  const t = useTranslations('auth.confirmEmail');
  const tErrors = useTranslations('errors');
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    confirmEmailAction,
    initialAuthFormState,
  );

  if (state.error === 'VERIFY_TOKEN_INVALID') {
    // Used up or expired in the meantime: there is nothing left to confirm.
    return <InvalidEmailLinkCard requestNewHref={requestNewHref} signedIn focusLink />;
  }

  return (
    <AuthCard aria-labelledby={TITLE_ID}>
      <AuthCardHeader titleId={TITLE_ID} title={t('title')} subtitle={t('subtitle')} />
      <form action={formAction} className="flex flex-col gap-[18px]">
        <input type="hidden" name="token" value={token} />
        <FormError>{state.error ? tErrors(state.error) : null}</FormError>
        <SubmitButton pending={isPending}>{t('submit')}</SubmitButton>
      </form>
    </AuthCard>
  );
}

/**
 * The link was opened signed out, or signed in as another account: "Sign in to confirm this
 * address". Signed out: sign in (and come back here), or reset the password when it isn't known.
 * Another account: sign out first.
 */
export function SignInToConfirmCard({
  email,
  signedInAs,
  token,
  signInHref,
}: {
  /** The address the link confirms. */
  email: string;
  /** The address of the account signed in on this browser, or null when signed out. */
  signedInAs: string | null;
  token: string;
  /** /login?callbackUrl=<this link> */
  signInHref: Route;
}) {
  const t = useTranslations('auth.confirmEmail');

  return (
    <AuthCard aria-labelledby={TITLE_ID}>
      <AuthCardHeader
        titleId={TITLE_ID}
        title={t('signInTitle')}
        subtitle={t.rich('signInBody', { email, strong: strongAddress })}
      />
      {signedInAs === null ? (
        <>
          <Link href={signInHref} className={primaryLinkClass}>
            {t('signIn')}
          </Link>
          <Link href={WEB_ROUTES.forgotPassword} className={secondaryLinkClass}>
            {t('forgotPassword')}
          </Link>
        </>
      ) : (
        <>
          <p className="rounded-md bg-surface-sunken px-2.5 py-2 text-[13px] leading-normal text-ink-secondary">
            {t.rich('otherAccount', { email: signedInAs, strong: strongAddress })}
          </p>
          {/* Drops the cached API token first, like every sign-out. */}
          <form action={signOutToConfirmEmailAction} onSubmit={() => clearApiToken()}>
            <input type="hidden" name="token" value={token} />
            <SubmitButton>{t('switchAccount')}</SubmitButton>
          </form>
        </>
      )}
    </AuthCard>
  );
}

/** The link could not be checked right now (rate limited, API unavailable…): try again. */
export function ConfirmEmailUnavailableCard({
  error,
  retryHref,
}: {
  error: ErrorCode;
  retryHref: Route;
}) {
  const t = useTranslations('auth.confirmEmail');
  const tErrors = useTranslations('errors');

  return (
    <AuthCard aria-labelledby={TITLE_ID}>
      <AuthCardHeader titleId={TITLE_ID} title={t('title')} subtitle={t('subtitle')} />
      <FormError>{tErrors(error)}</FormError>
      <Link href={retryHref} className={primaryLinkClass}>
        {t('tryAgain')}
      </Link>
    </AuthCard>
  );
}
