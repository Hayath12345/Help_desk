// /verify-email/confirm states (RR-SEC-1): only the link's own account gets "Confirm"; signed out
// or signed in as someone else, the page asks to sign in to that account. The session, the link
// lookup (API) and the server actions are mocked; the page is rendered like Next would.
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupEmailLink } from '@/lib/auth/email-link';
import { getCurrentUser, type CurrentUser } from '@/lib/session';
import arAuth from '@/messages/ar/auth.json';
import arErrors from '@/messages/ar/errors.json';
import enAuth from '@/messages/en/auth.json';
import enErrors from '@/messages/en/errors.json';
import ConfirmEmailPage from './page';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const messages = {
  en: { auth: enAuth, errors: enErrors },
  ar: { auth: arAuth, errors: arErrors },
} as const;
const locale = vi.hoisted(() => ({ current: 'en' as 'en' | 'ar' }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: locale.current,
      messages: messages[locale.current],
      namespace: namespace as never,
    }),
}));
vi.mock('@/lib/session', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/auth/email-link', () => ({ lookupEmailLink: vi.fn() }));
// Server actions and the browser token cache can't load outside Next; the cards only pass them on.
vi.mock('@/app/actions/auth', () => ({
  confirmEmailAction: vi.fn(),
  signOutToConfirmEmailAction: vi.fn(),
}));
vi.mock('@/lib/api/browser', () => ({ clearApiToken: vi.fn() }));

const currentUser = vi.mocked(getCurrentUser);
const lookup = vi.mocked(lookupEmailLink);

const TOKEN = 'T'.repeat(43);
const OWNER_ID = '6f1c2a0e-4b6d-4c1e-9a7f-2d3b4c5d6e7f';
const OWNER_EMAIL = 'new.client@hamad.qa';
const LINK = `/verify-email/confirm?token=${TOKEN}`;

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: OWNER_ID,
    name: 'New Client',
    email: OWNER_EMAIL,
    role: 'CLIENT',
    status: 'ACTIVE',
    orgId: null,
    locale: 'en',
    sessionVersion: 0,
    emailVerified: false,
    ...overrides,
  };
}

async function renderPage(params: { token?: string } = { token: TOKEN }): Promise<string> {
  const element = await ConfirmEmailPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale.current}
      messages={messages[locale.current]}
      timeZone="UTC"
    >
      {element}
    </NextIntlClientProvider>,
  );
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const decode = (value: string | undefined) => (value ?? '').replaceAll('&amp;', '&');

beforeEach(() => {
  vi.clearAllMocks();
  locale.current = 'en';
  currentUser.mockResolvedValue(null);
  lookup.mockResolvedValue({ status: 'valid', owner: { userId: OWNER_ID, email: OWNER_EMAIL } });
});

describe('ConfirmEmailPage', () => {
  it('malformed or missing token: the invalid-link card, without asking the API', async () => {
    for (const params of [{ token: 'not-a-token' }, {}]) {
      const html = await renderPage(params);
      expect(html).toContain('This link is invalid or has expired');
      expect(hrefs(html)).toEqual(['/login', '/login']); // "Request a new link", "Back to sign in"
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('owner signed in: the Confirm form (POST), nothing confirmed on GET', async () => {
    currentUser.mockResolvedValue(user());
    const html = await renderPage();
    expect(lookup).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain('Confirm your email address');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Confirm<\/span><\/button>/);
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(html).not.toContain('Sign in to confirm this address');
  });

  it('signed out: "Sign in to confirm this address" with the address, a sign-in that comes back, and reset', async () => {
    const html = await renderPage();
    expect(html).toContain('Sign in to confirm this address');
    expect(html).toContain(
      `<strong dir="ltr" class="font-medium text-ink">${OWNER_EMAIL}</strong>`,
    );
    expect(hrefs(html).map(decode)).toEqual([
      `/login?callbackUrl=${encodeURIComponent(LINK)}`,
      '/forgot-password',
    ]);
    // No way to confirm from here.
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain(`value="${TOKEN}"`);
  });

  it('another account signed in: says who is signed in and offers "Sign out and continue"', async () => {
    currentUser.mockResolvedValue(
      user({
        id: '11111111-1111-4111-8111-111111111111',
        email: 'other@qnb.com',
        emailVerified: true,
      }),
    );
    const html = await renderPage();
    expect(html).toContain('Sign in to confirm this address');
    expect(html).toContain(`>${OWNER_EMAIL}</strong>`);
    expect(html).toContain('>other@qnb.com</strong>');
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*>.*Sign out and continue<\/span><\/button>/,
    );
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(hrefs(html)).toEqual([]);
    expect(html).not.toContain('>Confirm<');
  });

  it('used or expired link: the invalid-link card; "Request a new link" resends when signed in', async () => {
    lookup.mockResolvedValue({ status: 'invalid' });
    const signedOut = await renderPage();
    expect(signedOut).toContain('This link is invalid or has expired');
    expect(hrefs(signedOut)).toEqual(['/login', '/login']);

    currentUser.mockResolvedValue(user());
    const unverified = await renderPage();
    expect(unverified).toContain('This link is invalid or has expired');
    expect(hrefs(unverified)).toEqual(['/verify-email']);
  });

  it('used or expired link while already confirmed (e.g. after Google): straight to the landing page', async () => {
    lookup.mockResolvedValue({ status: 'invalid' });
    currentUser.mockResolvedValue(user({ emailVerified: true }));
    await expect(redirectOf(() => renderPage())).resolves.toBe('/tickets');
    currentUser.mockResolvedValue(user({ emailVerified: true, status: 'PENDING_APPROVAL' }));
    await expect(redirectOf(() => renderPage())).resolves.toBe('/pending');
  });

  it('link could not be checked: the error and "Try again" on the same link', async () => {
    lookup.mockResolvedValue({ status: 'error', error: 'RATE_LIMITED' });
    const html = await renderPage();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Too many attempts.');
    expect(hrefs(html).map(decode)).toEqual([LINK]);
    expect(html).not.toContain('type="submit"');
  });

  it('Arabic: the sign-in card is translated and the address stays left-to-right', async () => {
    locale.current = 'ar';
    const html = await renderPage();
    expect(html).toContain(arAuth.confirmEmail.signInTitle);
    expect(html).toContain(arAuth.confirmEmail.signIn);
    expect(html).toContain(
      `<strong dir="ltr" class="font-medium text-ink">${OWNER_EMAIL}</strong>`,
    );
  });
});
