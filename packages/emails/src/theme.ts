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

/** Where a shortened block value can be read in full ('any' = the template names no app). */
export type TruncationSurface = 'portal' | 'console' | 'any';

export interface LayoutStrings {
  brand: string;
  footer: string;
  automated: string;
  linkFallback: string;
  /** Shown after a block variable cut at BLOCK_MAX_CHARS: a message (description / reply) or a list. */
  truncated: Record<'message' | 'list', Record<TruncationSurface, string>>;
}

/** Fixed UI strings of the layout (template text itself comes from the database). */
export const layoutStrings: Readonly<Record<Locale, LayoutStrings>> = {
  en: {
    brand: 'Loons Help Desk',
    footer: 'Loons Help Desk · Loons Group',
    automated: 'This is an automated message. Please do not reply to this email.',
    linkFallback: "If the button doesn't work, copy and paste this link into your browser:",
    truncated: {
      message: {
        portal: 'This message has been shortened. View the full message in the portal.',
        console: 'This message has been shortened. View the full message in the console.',
        any: 'This message has been shortened. Open the ticket to read the full message.',
      },
      list: {
        portal: 'This list has been shortened. View all tickets in the portal.',
        console: 'This list has been shortened. View all tickets in the console.',
        any: 'This list has been shortened. Open the queue to see all tickets.',
      },
    },
  },
  ar: {
    brand: 'Loons Help Desk',
    footer: 'Loons Help Desk · Loons Group',
    automated: 'هذه رسالة آلية، يرجى عدم الرد على هذا البريد.',
    linkFallback: 'إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:',
    truncated: {
      message: {
        portal: 'تم اختصار هذه الرسالة. اطّلع على الرسالة كاملة في البوابة.',
        console: 'تم اختصار هذه الرسالة. اطّلع على الرسالة كاملة في وحدة التحكم.',
        any: 'تم اختصار هذه الرسالة. افتح التذكرة لقراءة الرسالة كاملة.',
      },
      list: {
        portal: 'تم اختصار هذه القائمة. اطّلع على جميع التذاكر في البوابة.',
        console: 'تم اختصار هذه القائمة. اطّلع على جميع التذاكر في وحدة التحكم.',
        any: 'تم اختصار هذه القائمة. افتح قائمة التذاكر لعرضها كلها.',
      },
    },
  },
};
