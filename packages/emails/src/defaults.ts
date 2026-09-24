import type { Locale } from '@loons/shared';

// Built-in text for each transactional email. The admin panel edits the `EmailTemplate` rows
// (subject/body, EN + AR); these defaults are used when a row is missing or inactive.
// CTA labels are part of the layout and stay in code. Variable names match the seeded rows
// (packages/db/prisma/seed-data/email-templates.ts).

export const EMAIL_TEMPLATE_KEYS = ['PASSWORD_RESET', 'EMAIL_VERIFICATION', 'GOOGLE_LINKED'] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

export interface EmailTemplateText {
  subjectEn: string;
  bodyEn: string;
  subjectAr: string;
  bodyAr: string;
}

export interface DefaultEmailTemplate extends EmailTemplateText {
  key: EmailTemplateKey;
  /** Placeholders the sender provides (shown to admins in the template editor). */
  variables: readonly string[];
  ctaEn?: string;
  ctaAr?: string;
}

export const DEFAULT_EMAIL_TEMPLATES: Readonly<Record<EmailTemplateKey, DefaultEmailTemplate>> = {
  PASSWORD_RESET: {
    key: 'PASSWORD_RESET',
    variables: ['name', 'resetUrl', 'expiresMinutes'],
    subjectEn: 'Reset your Loons Help Desk password',
    bodyEn: [
      'Hi {{name}},',
      'We received a request to reset the password for your Loons Help Desk account. Use the button below to choose a new password. The link expires in {{expiresMinutes}} minutes and can only be used once.',
      "If you didn't ask for this, you can safely ignore this email — your password won't change.",
    ].join('\n\n'),
    subjectAr: 'إعادة تعيين كلمة المرور لحسابك في Loons Help Desk',
    bodyAr: [
      'مرحباً {{name}}،',
      'تلقّينا طلباً لإعادة تعيين كلمة المرور لحسابك في Loons Help Desk. استخدم الزر أدناه لاختيار كلمة مرور جديدة. تنتهي صلاحية الرابط خلال {{expiresMinutes}} دقيقة ويمكن استخدامه مرة واحدة فقط.',
      'إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان ولن تتغير كلمة المرور.',
    ].join('\n\n'),
    ctaEn: 'Reset password',
    ctaAr: 'إعادة تعيين كلمة المرور',
  },
  EMAIL_VERIFICATION: {
    key: 'EMAIL_VERIFICATION',
    variables: ['name', 'verifyUrl', 'expiresHours'],
    subjectEn: 'Confirm your email address for Loons Help Desk',
    bodyEn: [
      'Hi {{name}},',
      'Thanks for signing up for Loons Help Desk. Use the button below to confirm your email address and finish setting up your account. The link expires in {{expiresHours}} hours and can only be used once.',
      "If you didn't create an account, you can safely ignore this email.",
    ].join('\n\n'),
    subjectAr: 'تأكيد بريدك الإلكتروني في Loons Help Desk',
    bodyAr: [
      'مرحباً {{name}}،',
      'شكراً لتسجيلك في Loons Help Desk. استخدم الزر أدناه لتأكيد بريدك الإلكتروني وإكمال إعداد حسابك. تنتهي صلاحية الرابط خلال {{expiresHours}} ساعة ويمكن استخدامه مرة واحدة فقط.',
      'إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة بأمان.',
    ].join('\n\n'),
    ctaEn: 'Confirm email address',
    ctaAr: 'تأكيد البريد الإلكتروني',
  },
  // Sent when Google is first linked to an account that had a password: the password is removed
  // and every other session signed out (whoever chose that password may not own the mailbox).
  GOOGLE_LINKED: {
    key: 'GOOGLE_LINKED',
    variables: ['name', 'signInUrl'],
    subjectEn: 'Google sign-in was added to your Loons Help Desk account',
    bodyEn: [
      'Hi {{name}},',
      'Google sign-in was just added to your Loons Help Desk account. To keep your account safe, we removed its password and signed out all other sessions.',
      'From now on, sign in with “Continue with Google”. To use a password again, choose “Forgot password?” on the sign-in page and set a new one.',
      "If you didn't add Google sign-in, contact Loons Support right away.",
    ].join('\n\n'),
    subjectAr: 'تمت إضافة تسجيل الدخول عبر Google إلى حسابك في مكتب دعم لونز',
    bodyAr: [
      'مرحباً {{name}}،',
      'تمت للتو إضافة تسجيل الدخول عبر Google إلى حسابك في مكتب دعم لونز. وحفاظاً على أمان حسابك، أزلنا كلمة المرور الخاصة به وسجّلنا الخروج من جميع الجلسات الأخرى.',
      'من الآن فصاعداً، سجّل الدخول باستخدام «المتابعة باستخدام Google». ولاستخدام كلمة مرور مجدداً، اختر «نسيت كلمة المرور؟» في صفحة تسجيل الدخول وعيّن كلمة مرور جديدة.',
      'إذا لم تُضِف تسجيل الدخول عبر Google بنفسك، فتواصل مع دعم لونز فوراً.',
    ].join('\n\n'),
    ctaEn: 'Sign in',
    ctaAr: 'تسجيل الدخول',
  },
};

export interface LocalizedTemplateText {
  /** The language actually used (Arabic falls back to English when its text is empty). */
  locale: Locale;
  subject: string;
  body: string;
}

/** Picks the subject/body for `locale`, falling back to English when the Arabic text is empty. */
export function pickTemplateText(template: EmailTemplateText, locale: Locale): LocalizedTemplateText {
  if (locale === 'ar' && template.subjectAr.trim() !== '' && template.bodyAr.trim() !== '') {
    return { locale: 'ar', subject: template.subjectAr, body: template.bodyAr };
  }
  return { locale: 'en', subject: template.subjectEn, body: template.bodyEn };
}

/** CTA label of a built-in template in the given language. */
export function defaultCtaLabel(key: EmailTemplateKey, locale: Locale): string | undefined {
  const template = DEFAULT_EMAIL_TEMPLATES[key];
  return locale === 'ar' ? (template.ctaAr ?? template.ctaEn) : template.ctaEn;
}
