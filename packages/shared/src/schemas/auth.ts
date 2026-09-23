import { z } from 'zod';
import { LOCALES } from '../enums.ts';
import { LOGIN_AUDIENCES } from '../auth.ts';

// Error messages are i18n keys under the `validation` namespace of the web app.

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'validation.email' }).max(254, { error: 'validation.email' }));

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN, { error: 'validation.passwordMin' })
  .max(PASSWORD_MAX, { error: 'validation.passwordMax' })
  .refine((v) => /[A-Za-z\u0600-\u06FF]/.test(v) && /\d/.test(v), {
    error: 'validation.passwordComplexity',
  });

export const loginSchema = z.object({
  email: emailSchema,
  // Existing passwords are only length-bounded; policy applies when setting a new one.
  password: z.string().min(1, { error: 'validation.required' }).max(PASSWORD_MAX),
  audience: z.enum(LOGIN_AUDIENCES).default('client'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  name: z.string().trim().min(2, { error: 'validation.nameMin' }).max(100),
  company: z.string().trim().max(120).optional().default(''),
  email: emailSchema,
  password: newPasswordSchema,
  locale: z.enum(LOCALES).default('en'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const forgotPasswordSchema = z.object({
  email: emailSchema,
  locale: z.enum(LOCALES).default('en'),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(32).max(256),
  password: newPasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const OAUTH_PROVIDERS = ['GOOGLE', 'MICROSOFT_ENTRA_ID'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Body of POST /internal/auth/oauth (web server → API, guarded by INTERNAL_API_KEY). */
export const oauthResolveSchema = z.object({
  provider: z.enum(OAUTH_PROVIDERS),
  providerAccountId: z.string().min(1).max(255),
  email: emailSchema,
  emailVerified: z.boolean(),
  name: z.string().trim().max(200).default(''),
  locale: z.enum(LOCALES).default('en'),
});
export type OAuthResolveInput = z.infer<typeof oauthResolveSchema>;

export const updateLocaleSchema = z.object({ locale: z.enum(LOCALES) });
