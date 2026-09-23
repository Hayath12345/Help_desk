'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { WEB_ROUTES } from '@loons/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { useForm } from 'react-hook-form';
import { forgotPasswordAction } from '@/app/actions/auth';
import {
  forgotPasswordFormSchema,
  initialAuthFormState,
  type AuthFormState,
  type ForgotPasswordFormValues,
} from '@/lib/auth/forms';
import { cn } from '@/lib/utils';
import { AuthCard, AuthCardHeader } from './auth-card';
import { AuthField } from './auth-field';
import { FormError } from './form-message';
import { useActionSubmit, useServerFieldErrors, useValidationMessage } from './form-hooks';
import { outlineButtonClass } from './styles';
import { SubmitButton } from './submit-button';
import { SwitchCard } from './switch-card';

/**
 * Forgot-password screen: the request card (+ the staff switch card, as in the design), then
 * the "Check your inbox" card once the API accepted the request.
 */
export function ForgotPasswordFlow() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const validationMessage = useValidationMessage();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    forgotPasswordAction,
    initialAuthFormState,
  );

  const form = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordFormSchema),
    defaultValues: { email: '' },
  });
  useServerFieldErrors(form, state);
  const onSubmit = useActionSubmit(form, formAction);
  const { errors } = form.formState;

  if (state.status === 'success') {
    return (
      <AuthCard aria-labelledby="forgot-sent-title" aria-live="polite">
        <AuthCardHeader
          titleId="forgot-sent-title"
          title={t('forgot.sentTitle')}
          subtitle={t.rich('forgot.sentBody', {
            email: state.email ?? '',
            strong: (chunks) => (
              <strong dir="ltr" className="font-medium text-ink">
                {chunks}
              </strong>
            ),
          })}
        />
        <Link
          href={WEB_ROUTES.clientLogin}
          className={cn(outlineButtonClass, 'inline-flex items-center justify-center')}
        >
          {t('forgot.backToSignIn')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <>
      <AuthCard aria-labelledby="forgot-title">
        <AuthCardHeader
          titleId="forgot-title"
          title={t('forgot.title')}
          subtitle={t('forgot.subtitle')}
        />
        <form
          action={formAction}
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-[18px]"
        >
          <AuthField
            id="forgot-email"
            label={t('fields.email')}
            type="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            error={validationMessage(errors.email?.message)}
            {...form.register('email')}
          />
          <FormError>{state.error ? tErrors(state.error) : null}</FormError>
          <SubmitButton pending={isPending}>{t('forgot.submit')}</SubmitButton>
          <Link
            href={WEB_ROUTES.clientLogin}
            className="text-center text-[13px] text-brand-ink hover:text-ink"
          >
            {t('forgot.back')}
          </Link>
        </form>
      </AuthCard>
      <SwitchCard
        kicker={t('login.switchKicker')}
        text={t('login.switchText')}
        href={WEB_ROUTES.staffLogin}
        action={t('login.switchAction')}
      />
    </>
  );
}
