// Form schemas for the auth screens (client-side react-hook-form AND server-action re-validation).
// They reuse the shared API schemas; error messages are keys of the `validation` namespace.
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  forgotPasswordSchema,
  loginSchema,
  newPasswordSchema,
  registerSchema,
} from '@loons/shared';
import { z } from 'zod';
import type { AuthErrorKey } from './errors';

export { PASSWORD_MAX, PASSWORD_MIN };

/** Email + password (the audience is fixed by the page the form lives on). */
export const loginFormSchema = loginSchema.pick({ email: true, password: true });
export type LoginFormValues = z.input<typeof loginFormSchema>;

/** Sign-up: the design asks for the company, so it is required here (the API allows empty). */
export const signupFormSchema = registerSchema.pick({ email: true, password: true }).extend({
  name: z
    .string()
    .trim()
    .min(2, { error: 'validation.nameMin' })
    .max(100, { error: 'validation.tooLong' }),
  company: z
    .string()
    .trim()
    .min(1, { error: 'validation.companyRequired' })
    .max(120, { error: 'validation.tooLong' }),
});
export type SignupFormValues = z.input<typeof signupFormSchema>;

export const forgotPasswordFormSchema = forgotPasswordSchema.pick({ email: true });
export type ForgotPasswordFormValues = z.input<typeof forgotPasswordFormSchema>;

export const resetPasswordFormSchema = z
  .object({
    password: newPasswordSchema,
    confirmPassword: z.string().min(1, { error: 'validation.required' }),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    error: 'validation.passwordMismatch',
  });
export type ResetPasswordFormValues = z.input<typeof resetPasswordFormSchema>;

/** State returned by the auth server actions (consumed with useActionState). */
export interface AuthFormState<Field extends string = string> {
  status: 'idle' | 'error' | 'success';
  /** Form-level error (key of the `errors` namespace). */
  error?: AuthErrorKey;
  /** Per-field errors (`validation.*` keys). */
  fieldErrors?: Partial<Record<Field, string>>;
  /** Forgot password: the address the reset link was sent to. */
  email?: string;
}

export const initialAuthFormState: AuthFormState = { status: 'idle' };

/**
 * Shape of the single-use tokens in emailed links (password reset, email confirmation): 32 random
 * bytes as base64url, within the bounds the API accepts. Anything else is rejected before any call.
 */
const EMAIL_LINK_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function isEmailLinkToken(value: string): boolean {
  return EMAIL_LINK_TOKEN.test(value);
}

/** First issue per top-level field, as `validation.*` keys. */
export function fieldErrorsFrom(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field !== 'string' || field in errors) continue;
    errors[field] = issue.message;
  }
  return errors;
}

/** Reads a text field from FormData ('' when missing or a file). */
export function formText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
