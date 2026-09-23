'use client';

import { useTranslations } from 'next-intl';
import { startTransition, useCallback, useEffect } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import { PASSWORD_MAX, PASSWORD_MIN, type AuthFormState } from '@/lib/auth/forms';

const VALIDATION_PREFIX = 'validation.';

/**
 * Translates a zod / API validation message (`validation.<key>`) into the current language.
 * Anything that is not one of our keys (e.g. a zod default message) becomes a generic hint.
 */
export function useValidationMessage(): (message: string | undefined) => string | undefined {
  const t = useTranslations('validation');
  return useCallback(
    (message) => {
      if (!message) return undefined;
      const key = message.startsWith(VALIDATION_PREFIX)
        ? message.slice(VALIDATION_PREFIX.length)
        : message;
      if (!t.has(key as never)) return t('invalid');
      // The key is dynamic (it comes from zod / the API), so call the translator untyped.
      const translate = t as unknown as (key: string, values: Record<string, number>) => string;
      return translate(key, { min: PASSWORD_MIN, max: PASSWORD_MAX });
    },
    [t],
  );
}

/**
 * onSubmit handler: validates with react-hook-form (zod) first and, only when valid, dispatches
 * the form's FormData to the server action inside a transition (so useActionState's pending
 * flag works). The form also keeps `action={formAction}` so it still submits without JavaScript.
 */
export function useActionSubmit<T extends FieldValues>(
  form: UseFormReturn<T>,
  dispatch: (payload: FormData) => void,
  beforeDispatch?: () => void,
): (event: React.FormEvent<HTMLFormElement>) => void {
  return useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      const element = event.currentTarget;
      void form.handleSubmit(() => {
        beforeDispatch?.();
        const payload = new FormData(element);
        startTransition(() => dispatch(payload));
      })(event);
    },
    [form, dispatch, beforeDispatch],
  );
}

/** Copies server-side field errors from an action result into react-hook-form. */
export function useServerFieldErrors<T extends FieldValues>(
  form: UseFormReturn<T>,
  state: AuthFormState,
): void {
  useEffect(() => {
    const entries = Object.entries(state.fieldErrors ?? {});
    entries.forEach(([name, message], index) => {
      if (!message) return;
      form.setError(name as Path<T>, { type: 'server', message }, { shouldFocus: index === 0 });
    });
  }, [form, state]);
}
