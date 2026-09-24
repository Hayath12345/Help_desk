// Client sign-up → email verification (SEC-1, RR-SEC-1) → password reset while signed in (F4),
// end to end: the API (seeded org domains), its email worker, Mailpit and the web app. The
// Playwright config starts what is not running yet.
//
// Each run registers one new client (`e2e-<timestamp>@hamad.qa`), deleted again by the global
// teardown (e2e/global-teardown.ts). The API allows 5 sign-ups per hour per IP, so back-to-back
// reruns may still be rate limited (README → Troubleshooting).
import { expect, test } from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './fixtures';
import { waitForEmailLink } from './mailpit';

/** hamad.qa belongs to a seeded organisation, so the new client joins it once verified. */
const ORG_DOMAIN = 'hamad.qa';
const PASSWORD = 'VerifyE2e2026';
/** A seeded demo client (another account signed in on the browser that opens the link). */
const OTHER_CLIENT_EMAIL = 'f.alsulaiti@ooredoo.qa';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'LoonsDemo2026';
const NEW_PASSWORD = 'VerifyE2e2027';
const CONFIRM_LINK = /https?:\/\/[^\s"'<>]+\/verify-email\/confirm\?token=[A-Za-z0-9_-]+/;
const RESET_LINK = /https?:\/\/[^\s"'<>]+\/reset-password\?token=[A-Za-z0-9_-]+/;

test.describe('email verification', () => {
  test('a new client confirms the emailed link, lands on /tickets, then resets the password', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    const email = `e2e-${Date.now()}@${ORG_DOMAIN}`;

    await page.goto('/signup');
    await page.getByLabel('Full name').fill('E2E Verification');
    await page.getByLabel('Company').fill('Hamad Medical Corporation');
    await page.getByLabel('Work email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    // Signed in, but held on /verify-email until the address is confirmed.
    await expect(page).toHaveURL(/\/verify-email$/);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // An unverified client cannot open the portal (or anything else).
    await page.goto('/tickets');
    await expect(page).toHaveURL(/\/verify-email$/);
    await page.goto('/help');
    await expect(page).toHaveURL(/\/verify-email$/);

    // "I've verified — continue" before confirming just says "not yet".
    await page.getByRole('button', { name: "I've verified — continue" }).click();
    await expect(page).toHaveURL(/\/verify-email\?checked=1$/);
    await expect(page.getByText("We haven't received your confirmation yet.")).toBeVisible();

    const link = await waitForEmailLink(request, email, CONFIRM_LINK);

    // RR-SEC-1: the link confirms nothing outside its own account's session. On another browser
    // it asks to sign in to that account — signed out, or signed in as someone else — and comes
    // back to the link afterwards.
    await test.step('the link asks for its own account elsewhere', async () => {
      const other = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
      const elsewhere = await other.newPage();
      const signIn = async (address: string, password: string) => {
        await expect(elsewhere).toHaveURL(/\/login\?callbackUrl=%2Fverify-email%2Fconfirm/);
        await elsewhere.getByLabel('Email', { exact: true }).fill(address);
        await elsewhere.getByLabel('Password', { exact: true }).fill(password);
        await elsewhere.getByRole('button', { name: 'Sign in', exact: true }).click();
      };
      const signInCard = elsewhere.getByRole('heading', { name: 'Sign in to confirm this address' });

      await elsewhere.goto(link);
      await expect(signInCard).toBeVisible();
      await expect(elsewhere.getByText(email)).toBeVisible();
      await expect(elsewhere.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);

      // Signing in as another account comes back here, and still can't confirm.
      await elsewhere.getByRole('link', { name: 'Sign in to continue' }).click();
      await signIn(OTHER_CLIENT_EMAIL, DEMO_PASSWORD);
      await expect(signInCard).toBeVisible();
      await expect(elsewhere.getByText(OTHER_CLIENT_EMAIL)).toBeVisible();
      await expect(elsewhere.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);

      // "Sign out and continue", then the link's own account: now it may confirm (not pressed:
      // the registrant's browser confirms below).
      await elsewhere.getByRole('button', { name: 'Sign out and continue' }).click();
      await signIn(email, PASSWORD);
      await expect(
        elsewhere.getByRole('heading', { name: 'Confirm your email address' }),
      ).toBeVisible();
      await other.close();
    });

    // Opening the link does nothing by itself (mail scanners pre-fetch links)…
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Confirm your email address' })).toBeVisible();

    // …the Confirm button (POST) verifies the address and refreshes this session.
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);

    // The link is single use: opening it again just continues to the portal.
    await page.goto(link);
    await expect(page).toHaveURL(/\/tickets(?:[/?#]|$)/);

    // F4 (same new account, so no demo password changes): a reset link works while signed in,
    // and a successful reset signs this browser out.
    await test.step('password reset while signed in', async () => {
      const other = await browser.newContext({ baseURL, storageState: ENGLISH_STORAGE_STATE });
      const signedOut = await other.newPage();
      await signedOut.goto('/forgot-password');
      await signedOut.getByLabel('Email', { exact: true }).fill(email);
      await signedOut.getByRole('button', { name: 'Send reset link' }).click();
      await expect(signedOut.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
      await other.close();

      const resetLink = await waitForEmailLink(request, email, RESET_LINK);
      await page.goto(resetLink);
      await expect(page).toHaveURL(/\/reset-password\?token=/);
      await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: 'Update password' }).click();
      await expect(page).toHaveURL(/\/login\?reset=1$/);
      await expect(page.getByText('Your password has been updated.')).toBeVisible();
      await page.goto('/tickets');
      await expect(page).toHaveURL(/\/login\?callbackUrl=%2Ftickets$/);
    });
  });

  test('the confirmation page never verifies on GET and rejects malformed links', async ({
    page,
  }) => {
    await page.goto('/verify-email/confirm?token=not-a-token');
    await expect(
      page.getByRole('heading', { name: 'This link is invalid or has expired' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  test('signed out, /verify-email goes to /login', async ({ page }) => {
    await page.goto('/verify-email');
    await expect(page).toHaveURL(/\/login$/);
  });
});
