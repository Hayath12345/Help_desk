/**
 * Every test starts with the UI language cookie set to English. After sign-in the cookie wins over
 * the user's stored locale, so locators stay stable even if a demo user's profile was switched to Arabic.
 */
export const ENGLISH_STORAGE_STATE = {
  cookies: [
    {
      name: 'NEXT_LOCALE',
      value: 'en',
      domain: 'localhost',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};
