import { WEB_ROUTES } from '@loons/shared';
import type { Metadata, Route } from 'next';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import {
  ConfirmEmailCard,
  ConfirmEmailUnavailableCard,
  InvalidEmailLinkCard,
  SignInToConfirmCard,
} from '@/components/auth/confirm-email';
import { firstParam } from '@/lib/auth/callback-url';
import { lookupEmailLink } from '@/lib/auth/email-link';
import { isEmailLinkToken } from '@/lib/auth/forms';
import {
  emailConfirmPath,
  landingPathFor,
  needsEmailVerification,
  signInToConfirmPath,
} from '@/lib/auth/routing';
import { getCurrentUser } from '@/lib/session';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.confirmEmail');
  // The token is in the URL: never leak it through the Referer header.
  return { title: t('metaTitle'), referrer: 'no-referrer' };
}

/**
 * Target of the link in the verification email (`/verify-email/confirm?token=…`). Public: it opens
 * signed in or out, and nothing is confirmed on GET. The address is only confirmed inside that
 * account's own session (RR-SEC-1): its owner gets "Confirm" (POST); signed out, or signed in as
 * someone else, the page asks to sign in to that account first.
 */
export default async function ConfirmEmailPage({ searchParams }: { searchParams: SearchParams }) {
  const [params, user] = await Promise.all([searchParams, getCurrentUser()]);
  const token = firstParam(params.token)?.trim() ?? '';
  const requestNewHref = (user ? WEB_ROUTES.verifyEmail : WEB_ROUTES.clientLogin) as Route;
  if (!isEmailLinkToken(token)) {
    return <InvalidEmailLinkCard requestNewHref={requestNewHref} signedIn={user !== null} />;
  }

  const link = await lookupEmailLink(token);
  if (link.status === 'invalid') {
    // Nothing left to confirm for a signed-in user whose own address is already confirmed (e.g.
    // they came back here after "Continue with Google", which confirms it): go on.
    if (user && !needsEmailVerification(user)) redirect(landingPathFor(user) as Route);
    return <InvalidEmailLinkCard requestNewHref={requestNewHref} signedIn={user !== null} />;
  }
  if (link.status === 'error') {
    return (
      <ConfirmEmailUnavailableCard
        error={link.error}
        retryHref={emailConfirmPath(token) as Route}
      />
    );
  }
  if (user?.id === link.owner.userId) {
    return <ConfirmEmailCard token={token} requestNewHref={requestNewHref} />;
  }
  return (
    <SignInToConfirmCard
      email={link.owner.email}
      signedInAs={user?.email ?? null}
      token={token}
      signInHref={signInToConfirmPath(token) as Route}
    />
  );
}
