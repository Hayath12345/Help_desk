import { DEFAULT_LOCALE, LOCALES, type Locale } from '@loons/shared';

export const locales = LOCALES;
export type AppLocale = Locale;
export const defaultLocale: AppLocale = DEFAULT_LOCALE;
/** Cookie holding the UI language. Also synced to the user's profile when signed in. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function getDir(locale: AppLocale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
