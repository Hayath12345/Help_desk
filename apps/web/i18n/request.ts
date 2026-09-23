import { cookies } from 'next/headers';
import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, LOCALE_COOKIE, locales } from './config';
import { loadMessages } from './messages';

export default getRequestConfig(async () => {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = hasLocale(locales, value) ? value : defaultLocale;
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: 'Asia/Qatar',
  };
});
