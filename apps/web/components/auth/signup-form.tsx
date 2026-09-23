'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { WEB_ROUTES } from '@loons/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { useForm } from 'react-hook-form';
import { registerAction } from '@/app/actions/auth';
import { clearApiToken } from '@/lib/api/browser';
import {
  PASSWORD_MIN,
  initialAuthFormState,
  signupFormSchema,
  type AuthFormState,
  type SignupFormValues,
} from '@/lib/auth/forms';
import { AuthField } from './auth-field';
import { FormError } from './form-message';
import { useActionSubmit, useServerFieldErrors, useValidationMessage } from './form-hooks';
import { SubmitButton } from './submit-button';

/** Client self-signup: Full name, Company, Work email, Password (+ policy hint). */
export function SignupForm() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const validationMessage = useValidationMessage();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    registerAction,
    initialAuthFormState,
  );

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: { name: '', company: '', email: '', password: '' },
  });
  useServerFieldErrors(form, state);
  const onSubmit = useActionSubmit(form, formAction, clearApiToken);
  const { errors } = form.formState;

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <AuthField
        id="signup-name"
        label={t('fields.fullName')}
        placeholder={t('fields.fullNamePlaceholder')}
        autoComplete="name"
        error={validationMessage(errors.name?.message)}
        {...form.register('name')}
      />
      <AuthField
        id="signup-company"
        label={t('fields.company')}
        placeholder={t('fields.companyPlaceholder')}
        autoComplete="organization"
        error={validationMessage(errors.company?.message)}
        {...form.register('company')}
      />
      <AuthField
        id="signup-email"
        label={t('fields.workEmail')}
        type="email"
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        error={validationMessage(errors.email?.message)}
        {...form.register('email')}
      />
      <AuthField
        id="signup-password"
        label={t('fields.password')}
        type="password"
        autoComplete="new-password"
        hint={t('fields.passwordHint', { min: PASSWORD_MIN })}
        error={validationMessage(errors.password?.message)}
        {...form.register('password')}
      />

      <FormError>{state.error ? tErrors(state.error) : null}</FormError>

      <SubmitButton pending={isPending}>{t('signup.submit')}</SubmitButton>
      <Link
        href={WEB_ROUTES.clientLogin}
        className="text-center text-[13px] text-brand-ink hover:text-ink"
      >
        {t('signup.haveAccount')}
      </Link>
    </form>
  );
}
