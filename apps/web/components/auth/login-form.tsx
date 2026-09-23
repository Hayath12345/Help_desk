'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { WEB_ROUTES } from '@loons/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState, useState } from 'react';
import { useForm } from 'react-hook-form';
import { clientLoginAction, staffLoginAction } from '@/app/actions/auth';
import { clearApiToken } from '@/lib/api/browser';
import type { AuthErrorKey } from '@/lib/auth/errors';
import {
  initialAuthFormState,
  loginFormSchema,
  type AuthFormState,
  type LoginFormValues,
} from '@/lib/auth/forms';
import { AuthField } from './auth-field';
import { FormError, FormNotice } from './form-message';
import { useActionSubmit, useServerFieldErrors, useValidationMessage } from './form-hooks';
import { textLinkClass } from './styles';
import { SubmitButton } from './submit-button';

type LoginFormProps = {
  audience: 'client' | 'staff';
  callbackUrl?: string | null;
  /** Error carried in the URL (?error=…), shown until the first submission. */
  initialError?: AuthErrorKey | null;
  /** Success notice carried in the URL (e.g. after a password reset). */
  notice?: string | null;
};

/** Email + password sign-in, for clients (/login) or development staff sign-in (/staff/login). */
export function LoginForm({ audience, callbackUrl, initialError, notice }: LoginFormProps) {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const validationMessage = useValidationMessage();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    audience === 'staff' ? staffLoginAction : clientLoginAction,
    initialAuthFormState,
  );
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });
  useServerFieldErrors(form, state);
  const onSubmit = useActionSubmit(form, formAction, () => {
    setSubmitted(true);
    // A different account may be signing in on this tab: never reuse the old API token.
    clearApiToken();
  });
  const { errors } = form.formState;

  const errorKey = state.error ?? (submitted ? null : initialError);
  const idPrefix = `${audience}-login`;

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-[18px]">
      <input type="hidden" name="callbackUrl" value={callbackUrl ?? ''} />
      {notice && !submitted ? <FormNotice>{notice}</FormNotice> : null}

      <AuthField
        id={`${idPrefix}-email`}
        label={t('fields.email')}
        type="email"
        autoComplete={audience === 'staff' ? 'username' : 'email'}
        inputMode="email"
        spellCheck={false}
        error={validationMessage(errors.email?.message)}
        {...form.register('email')}
      />
      <AuthField
        id={`${idPrefix}-password`}
        label={t('fields.password')}
        labelAside={
          audience === 'client' ? (
            <Link href={WEB_ROUTES.forgotPassword} className={textLinkClass}>
              {t('login.forgotPassword')}
            </Link>
          ) : null
        }
        type="password"
        autoComplete="current-password"
        error={validationMessage(errors.password?.message)}
        {...form.register('password')}
      />

      <FormError>{errorKey ? tErrors(errorKey) : null}</FormError>

      <SubmitButton pending={isPending}>{t('login.submit')}</SubmitButton>
    </form>
  );
}
