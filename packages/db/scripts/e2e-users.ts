// Accounts the Playwright suite creates (apps/web/e2e) and removes again after each run. Kept
// narrow on purpose: a local part the suite generates AND a domain it uses, so no real or seeded
// account can match.
import type { Prisma } from '../src/index.ts';

export const E2E_USER_PATTERNS = [
  // verify-email.spec.ts signs up e2e-<timestamp>@hamad.qa (a seeded organisation's domain).
  { prefix: 'e2e-', suffix: '@hamad.qa' },
  // Sign-ups on a domain no organisation owns (pending approval).
  { prefix: 'pending.', suffix: '@unmatched-e2e.test' },
] as const;

/** Prisma filter for the users created by the E2E suite. */
export function e2eUserWhere(): Prisma.UserWhereInput {
  return {
    role: 'CLIENT',
    OR: E2E_USER_PATTERNS.map(({ prefix, suffix }) => ({
      AND: [{ email: { startsWith: prefix } }, { email: { endsWith: suffix } }],
    })),
  };
}

/** Same rule in plain code (for tests and log lines). */
export function isE2eUserEmail(email: string): boolean {
  const value = email.toLowerCase();
  return E2E_USER_PATTERNS.some(
    ({ prefix, suffix }) =>
      value.startsWith(prefix) &&
      value.endsWith(suffix) &&
      value.length > prefix.length + suffix.length,
  );
}
