'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { WEB_ROUTES } from '@loons/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { useForm } from 'react-hook-form';
import { resetPasswordAction } from '@/app/actions/auth';
import {
  PASSWORD_MIN,
  initialAuthFormState,
  resetPasswordFormSchema,
  type AuthFormState,
  type ResetPasswordFormValues,
} from '@/lib/auth/forms';
import { AuthField } from './auth-field';
import { FormError } from './form-message';
import { useActionSubmit, useServerFieldErrors, useValidationMessage } from './form-hooks';
import { SubmitButton } from './submit-button';

/** New password + confirmation; success redirects to /login?reset=1 (server action). */
export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const validationMessage = useValidationMessage();
  const [state, formAction, isPending] = useActionState<AuthFormState, FormData>(
    resetPasswordAction,
    initialAuthFormState,
  );

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordFormSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });
  useServerFieldErrors(form, state);
  const onSubmit = useActionSubmit(form, formAction);
  const { errors } = form.formState;

  return (
    <form action={formAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-[18px]">
      <input type="hidden" name="token" value={token} />
      <AuthField
        id="reset-password"
        label={t('fields.newPassword')}
        type="password"
        autoComplete="new-password"
        hint={t('fields.passwordHint', { min: PASSWORD_MIN })}
        error={validationMessage(errors.password?.message)}
        {...form.register('password')}
      />
      <AuthField
        id="reset-confirm-password"
        label={t('fields.confirmPassword')}
        type="password"
        autoComplete="new-password"
        error={validationMessage(errors.confirmPassword?.message)}
        {...form.register('confirmPassword')}
      />

      <FormError>
        {state.error ? (
          <>
            {tErrors(state.error)}
            {state.error === 'RESET_TOKEN_INVALID' ? (
              <>
                {' '}
                <Link href={WEB_ROUTES.forgotPassword} className="font-medium underline">
                  {t('reset.requestNew')}
                </Link>
              </>
            ) : null}
          </>
        ) : null}
      </FormError>

      <SubmitButton pending={isPending}>{t('reset.submit')}</SubmitButton>
      <Link
        href={WEB_ROUTES.clientLogin}
        className="text-center text-[13px] text-brand-ink hover:text-ink"
      >
        {t('reset.back')}
      </Link>
    </form>
  );
}
