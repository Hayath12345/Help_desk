// Critical authentication flows. Needs the API (seeded demo data) and the web app — the
// Playwright config starts both (or reuses running ones). Demo users come from the db seed.
//
// The API rate-limits sign-in per (IP, email): flows are spread over several demo accounts and
// tests that only need "a signed-in client" reuse one saved session.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './fixtures';

const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const CLIENT_EMAIL = 'aisha.alkuwari@hamad.qa';
const CALLBACK_CLIENT_EMAIL = 'khalid.mansouri@qnb.com';
const REDIRECT_CLIENT_EMAIL = 'f.alsulaiti@ooredoo.qa';
const WRONG_PASSWORD_EMAIL = 'o.alnaimi@moi.gov.qa';
const AGENT_EMAIL = 'maya.ruiz@loonsgroup.com';
const SUPER_ADMIN_EMAIL = 'noor.alkaabi@loonsgroup.com';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
let clientSession: StorageState | undefined;

async function fillCredentials(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** A page signed in as the demo client (signs in once per run, then reuses the session). */
async function signedInClientPage(browser: Browser, baseURL: string | undefined) {
  if (!clientSession) {
    // browser.newContext() does not inherit the config `use` options, so pass the English cookie explicitly.
    const context = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
    const page = await context.newPage();
    await page.goto('/login');
    await fillCredentials(page, CLIENT_EMAIL, DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);
    clientSession = await context.storageState();
    await context.close();
  }
  const context = await browser.newContext({ baseURL, storageState: clientSession });
  return context.newPage();
}

/** Staff password sign-in exists only in development builds without Entra ID. */
async function staffSignIn(page: Page, email: string) {
  await page.goto('/staff/login');
  const devForm = page.getByLabel('Email', { exact: true });
  test.skip(
    (await devForm.count()) === 0,
    'Dev staff sign-in is disabled (Entra ID configured or AUTH_DEV_STAFF_LOGIN off)',
  );
  await fillCredentials(page, email, DEMO_PASSWORD);
}

/** Signs out through the app shell (a visible "Sign out" control, or one inside the user menu). */
async function signOut(page: Page) {
  const control = page
    .getByRole('button', { name: 'Sign out', exact: true })
    .or(page.getByRole('menuitem', { name: 'Sign out', exact: true }))
    .or(page.getByRole('link', { name: 'Sign out', exact: true }));
  if (
    !(await control
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    // Open the account menu (trigger named after the user, their initials or "account").
    await page
      .getByRole('button', { name: /aisha|al-kuwari|^AA$|account|user menu|profile/i })
      .first()
      .click();
  }
  await control.first().click();
}

test.describe('client sign-in', () => {
  test('valid credentials land on /tickets', async ({ browser, baseURL }) => {
    clientSession = undefined; // exercise the real sign-in here
    const page = await signedInClientPage(browser, baseURL);
    await page.goto('/');
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);
  });

  test('a wrong password shows a generic error and stays on /login', async ({ page }) => {
    await page.goto('/login');
    await fillCredentials(page, WRONG_PASSWORD_EMAIL, 'definitely-not-the-password-1');
    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('client-side validation runs before submitting', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill('not-an-email');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  });

  test('returns to the callbackUrl after signing in', async ({ page }) => {
    await page.goto('/help');
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fhelp$/);
    await fillCredentials(page, CALLBACK_CLIENT_EMAIL, DEMO_PASSWORD);
    await expect(page).toHaveURL(/\/help(?:[/?#]|$)/);
  });

  test('ignores an off-site callbackUrl (no open redirect)', async ({ page }) => {
    await page.goto('/login?callbackUrl=https%3A%2F%2Fevil.example%2Fphish');
    await fillCredentials(page, REDIRECT_CLIENT_EMAIL, DEMO_PASSWORD);
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/tickets/);
  });
});

test.describe('staff sign-in (development)', () => {
  test('an agent lands on /console/inbox', async ({ page }) => {
    await staffSignIn(page, AGENT_EMAIL);
    await expect(page).toHaveURL(/\/console\/inbox(?:[/?#]|$)/);
  });

  test('the super admin lands on /admin', async ({ page }) => {
    await staffSignIn(page, SUPER_ADMIN_EMAIL);
    await expect(page).toHaveURL(/\/admin(?:[/?#]|$)/);
  });

  test('staff cannot use the client login', async ({ page }) => {
    await page.goto('/login');
    await fillCredentials(page, AGENT_EMAIL, DEMO_PASSWORD);
    await expect(
      page.getByText('Loons staff sign in with Microsoft from the Support login page.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('route protection', () => {
  test('unauthenticated /console/inbox redirects to /staff/login', async ({ page }) => {
    await page.goto('/console/inbox');
    await expect(page).toHaveURL(/\/staff\/login\?callbackUrl=%2Fconsole%2Finbox$/);
    await expect(page.getByRole('heading', { name: 'Support login' })).toBeVisible();
  });

  test('unauthenticated / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a signed-in client visiting /console/inbox is sent to /tickets', async ({
    browser,
    baseURL,
  }) => {
    const page = await signedInClientPage(browser, baseURL);
    await page.goto('/console/inbox');
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);
  });

  test('a signed-in client visiting /login is sent home', async ({ browser, baseURL }) => {
    const page = await signedInClientPage(browser, baseURL);
    await page.goto('/login');
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);
  });

  test('GET /api/token is 401 signed out and returns a short-lived token signed in', async ({
    page,
    browser,
    baseURL,
  }) => {
    const anonymous = await page.request.get('/api/token');
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()['cache-control']).toContain('no-store');

    const clientPage = await signedInClientPage(browser, baseURL);
    const signedIn = await clientPage.request.get('/api/token');
    expect(signedIn.status()).toBe(200);
    expect(signedIn.headers()['cache-control']).toContain('no-store');
    const body = (await signedIn.json()) as { token: string; expiresAt: number };
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });
});

test.describe('language and sign-out', () => {
  test('the language toggle switches /login to Arabic (RTL)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByRole('button', { name: /switch language|العربية/i }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('heading', { name: 'تسجيل الدخول إلى دعم لونز' })).toBeVisible();
  });

  test('signing out returns to /login', async ({ browser, baseURL }) => {
    const page = await signedInClientPage(browser, baseURL);
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/tickets/);
    await signOut(page);
    await expect(page).toHaveURL(/\/login(?:[?#]|$)/);
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/login\?callbackUrl=%2Ftickets$/);
  });
});
