// Locale rule after sign-in (contract): the NEXT_LOCALE cookie wins and is persisted to the
// profile with PATCH /me; without a cookie, the cookie is set from the profile's locale.
import 'server-only';
import type { Locale, Role } from '@loons/shared';
import { hasLocale } from 'next-intl';
import { cookies } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { LOCALE_COOKIE, locales } from '@/i18n/config';
import { fetchAsUser } from '@/lib/api/internal';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export const LOCALE_COOKIE_OPTIONS = {
  path: '/',
  maxAge: ONE_YEAR_SECONDS,
  sameSite: 'lax',
} as const;

type CookieStore = Awaited<ReturnType<typeof cookies>>;

async function cookieStore(): Promise<CookieStore | null> {
  try {
    return await cookies();
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/** The UI locale from the NEXT_LOCALE cookie, if set to a supported value. */
export async function readLocaleCookie(): Promise<Locale | null> {
  const value = (await cookieStore())?.get(LOCALE_COOKIE)?.value;
  return hasLocale(locales, value) ? value : null;
}

/**
 * Applies the locale rule for a user who just signed in and returns the effective locale.
 * Never throws: a failure here must not block the sign-in.
 */
export async function syncLocaleOnSignIn(user: {
  id: string;
  role: Role;
  locale: Locale;
  sessionVersion: number;
}): Promise<Locale> {
  const store = await cookieStore();
  if (!store) return user.locale;

  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  if (hasLocale(locales, cookieLocale)) {
    if (cookieLocale !== user.locale) {
      try {
        await fetchAsUser(user, '/me', { method: 'PATCH', json: { locale: cookieLocale } });
      } catch (error) {
        unstable_rethrow(error);
        // Best effort: the cookie still drives the UI; the profile catches up next time.
      }
    }
    return cookieLocale;
  }

  try {
    store.set(LOCALE_COOKIE, user.locale, LOCALE_COOKIE_OPTIONS);
  } catch (error) {
    // Cookies are read-only while rendering Server Components; sign-in never runs there.
    unstable_rethrow(error);
  }
  return user.locale;
}
