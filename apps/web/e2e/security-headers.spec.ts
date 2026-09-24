// SEC-10 / SPEC-1: every web response carries the security headers from next.config.ts.
import { expect, test } from '@playwright/test';

for (const path of ['/login', '/staff/login', '/api/token']) {
  test(`${path} sends the security headers`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toMatch(/form-action 'self'/);
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy']).toContain('camera=()');
  });
}

test('the sign-in page renders under the CSP (no blocked scripts or styles)', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in to Loons Support' })).toBeVisible();
  // Client-side validation only works once the page is hydrated (i.e. its scripts ran).
  await page.getByLabel('Email', { exact: true }).fill('not-an-email');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  expect(violations).toEqual([]);
});
