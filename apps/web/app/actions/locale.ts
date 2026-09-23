'use server';

import { cookies } from 'next/headers';
import { hasLocale } from 'next-intl';
import { LOCALE_COOKIE, locales } from '@/i18n/config';
import { apiFetch } from '@/lib/api/server';
import { getCurrentUser } from '@/lib/session';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Switches the UI language.
 *
 * Sets the `NEXT_LOCALE` cookie (1 year, SameSite=Lax, path /). Setting a cookie in a Server Action
 * makes Next re-render the current route in the same round trip, so `<html lang dir>` and every
 * translation update without a manual refresh. When someone is signed in, the choice is also saved
 * to their profile (`PATCH /me`) so emails and future sessions use it; that call is best-effort.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  if (!hasLocale(locales, locale)) return;

  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });

  try {
    const user = await getCurrentUser();
    // Always send it: the session's cached locale may lag behind a previous toggle.
    if (user) await apiFetch<unknown>('/me', { method: 'PATCH', json: { locale }, user });
  } catch {
    // The cookie already switched the UI; a failed profile update must not break that.
  }
}
