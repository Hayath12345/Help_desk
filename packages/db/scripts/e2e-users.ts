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

// ───────────── Tickets ─────────────
// apps/web/e2e/tickets.spec.ts raises real tickets as a seeded demo client (the account itself is
// kept). They are recognised by a generated subject prefix AND a requester the suite signs in as.

/** Subject prefix of the tickets the suite raises: `[e2e:<timestamp>] …`. */
export const E2E_TICKET_SUBJECT_PREFIX = '[e2e:';
const E2E_TICKET_SUBJECT = /^\[e2e:\d{10,}\] \S/u;
/** Seeded demo clients the suite raises tickets as. */
export const E2E_TICKET_REQUESTERS = ['aisha.alkuwari@hamad.qa'] as const;

/**
 * Prisma filter for candidate E2E tickets (prefix + requester). Callers must also check each
 * subject with `isE2eTicket`, which requires the generated timestamp.
 */
export function e2eTicketWhere(): Prisma.TicketWhereInput {
  return {
    subject: { startsWith: E2E_TICKET_SUBJECT_PREFIX },
    requester: { role: 'CLIENT', email: { in: [...E2E_TICKET_REQUESTERS] } },
  };
}

/** Same rule in plain code: a generated `[e2e:<timestamp>] ` subject raised by a suite account. */
export function isE2eTicket(ticket: { subject: string; requesterEmail: string }): boolean {
  return (
    E2E_TICKET_SUBJECT.test(ticket.subject) &&
    (E2E_TICKET_REQUESTERS as readonly string[]).includes(ticket.requesterEmail.toLowerCase())
  );
}
