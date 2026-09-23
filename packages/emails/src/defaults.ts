import type { Locale } from '@loons/shared';

// Built-in text for each transactional email. The admin panel edits the `EmailTemplate` rows
// (subject/body, EN + AR); these defaults are used when a row is missing or inactive.
// CTA labels are part of the layout and stay in code. Variable names match the seeded rows
// (packages/db/prisma/seed-data/email-templates.ts).

export const EMAIL_TEMPLATE_KEYS = ['PASSWORD_RESET'] as const;
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
