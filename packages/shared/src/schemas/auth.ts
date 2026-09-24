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
  // Unicode-aware: letters of any script (\p{L}) and decimal digits of any script (\p{Nd}), so
  // Arabic-Indic digits typed on an Arabic keyboard count as numbers.
  .refine((v) => /\p{L}/u.test(v) && /\p{Nd}/u.test(v), {
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

/** Single-use token from an emailed link (password reset, email confirmation). */
export const emailLinkTokenSchema = z.string().min(32).max(256);

export const resetPasswordSchema = z.object({
  token: emailLinkTokenSchema,
  password: newPasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Body of POST /internal/auth/email/link: which account an emailed confirmation link is for. */
export const emailLinkSchema = z.object({ token: emailLinkTokenSchema });

/** Response of POST /internal/auth/email/link (the link is not used up). */
export const emailLinkOwnerSchema = z.object({ userId: z.uuid(), email: z.email() });
export type EmailLinkOwner = z.infer<typeof emailLinkOwnerSchema>;

/**
 * Body of POST /internal/auth/email/verify: the emailed token and the signed-in user (from the web
 * session). A link only confirms the address inside that account's own session.
 */
export const verifyEmailSchema = z.object({ token: emailLinkTokenSchema, userId: z.uuid() });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

/** Body of POST /internal/auth/email/resend (the signed-in user's id, from the web session). */
export const resendVerificationSchema = z.object({
  userId: z.uuid(),
  locale: z.enum(LOCALES).optional(),
});
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

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
