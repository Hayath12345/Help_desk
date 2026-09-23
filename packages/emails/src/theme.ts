import type { Locale } from '@loons/shared';
import { palette, radii } from '@loons/ui';

// Email clients can't read CSS variables, so the layout uses the raw token values from @loons/ui.

export type TextDirection = 'ltr' | 'rtl';

export function directionFor(locale: Locale): TextDirection {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/** Web fonts rarely load in mail clients, so each stack ends in widely installed fallbacks. */
export const emailFontStacks: Readonly<Record<Locale, string>> = {
  en: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  ar: "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, 'Geeza Pro', 'Noto Sans Arabic', Arial, sans-serif",
};

export const emailColors = {
  page: palette.page,
  surface: palette.surface,
  ink: palette.ink,
  inkSecondary: palette.inkSecondary,
  inkMuted: palette.inkMuted,
  inkSubtle: palette.inkSubtle,
  border: palette.border,
  divider: palette.divider,
  primary: palette.primary,
  primaryInk: palette.primaryInk,
  onPrimary: palette.surface,
} as const;

export const emailRadii = {
  logo: radii.sm,
  button: radii.md,
  card: radii['2xl'],
} as const;

/** Fixed UI strings of the layout (template text itself comes from the database). */
export const layoutStrings: Readonly<
  Record<Locale, { brand: string; footer: string; automated: string; linkFallback: string }>
> = {
  en: {
    brand: 'Loons Help Desk',
    footer: 'Loons Help Desk · Loons Group',
    automated: 'This is an automated message. Please do not reply to this email.',
    linkFallback: "If the button doesn't work, copy and paste this link into your browser:",
  },
  ar: {
    brand: 'Loons Help Desk',
    footer: 'Loons Help Desk · Loons Group',
    automated: 'هذه رسالة آلية، يرجى عدم الرد على هذا البريد.',
    linkFallback: 'إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:',
  },
};
