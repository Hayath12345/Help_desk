'use client';

import { useTranslations } from 'next-intl';
import { clearApiToken } from '@/lib/api/browser';
import { googleSignInAction, microsoftSignInAction } from '@/app/actions/auth';
import { SubmitButton } from './submit-button';

/** Google "G" mark as drawn in the design (bordered circle, Google blue). */
function GoogleMark() {
  return (
    <span
      aria-hidden
      dir="ltr"
      className="grid size-5 place-items-center rounded-full border border-line text-[13px] leading-none font-bold text-google-blue"
    >
      G
    </span>
  );
}

/** Microsoft four-squares mark drawn with design tokens (no hard-coded colours). */
function MicrosoftMark() {
  return (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-sm bg-surface">
      <span className="grid size-3.5 grid-cols-2 gap-px">
        <span className="bg-danger-strong" />
        <span className="bg-success-strong" />
        <span className="bg-brand" />
        <span className="bg-warning-strong" />
      </span>
    </span>
  );
}

export function GoogleSignInButton({ callbackUrl }: { callbackUrl?: string | null }) {
  const t = useTranslations('auth.login');
  return (
    <form action={googleSignInAction} onSubmit={() => clearApiToken()}>
      <input type="hidden" name="callbackUrl" value={callbackUrl ?? ''} />
      <SubmitButton appearance="outline" icon={<GoogleMark />}>
        {t('google')}
      </SubmitButton>
    </form>
  );
}

export function MicrosoftSignInButton({ callbackUrl }: { callbackUrl?: string | null }) {
  const t = useTranslations('auth.staffLogin');
  return (
    <form action={microsoftSignInAction} onSubmit={() => clearApiToken()}>
      <input type="hidden" name="callbackUrl" value={callbackUrl ?? ''} />
      <SubmitButton icon={<MicrosoftMark />}>{t('microsoft')}</SubmitButton>
    </form>
  );
}
