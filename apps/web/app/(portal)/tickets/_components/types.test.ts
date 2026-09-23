import { describe, expect, it } from 'vitest';
import { isTicketTab, matchesTab, type PortalTicketSummary } from './types';

const ticket = (status: PortalTicketSummary['status']): PortalTicketSummary => ({
  id: status,
  number: 1,
  subject: 's',
  category: 'c',
  preview: 'p',
  status,
  updatedAt: '2026-09-23T00:00:00.000Z',
});

describe('My tickets tabs', () => {
  it('accepts only known tab values (from ?tab=)', () => {
    expect(isTicketTab('all')).toBe(true);
    expect(isTicketTab('active')).toBe(true);
    expect(isTicketTab('solved')).toBe(true);
    expect(isTicketTab('open')).toBe(false);
    expect(isTicketTab(undefined)).toBe(false);
    expect(isTicketTab(['active'])).toBe(false);
  });

  it('treats SOLVED and CLOSED as solved and everything else as active', () => {
    for (const status of ['NEW', 'OPEN', 'PENDING'] as const) {
      expect(matchesTab(ticket(status), 'active')).toBe(true);
      expect(matchesTab(ticket(status), 'solved')).toBe(false);
    }
    for (const status of ['SOLVED', 'CLOSED'] as const) {
      expect(matchesTab(ticket(status), 'active')).toBe(false);
      expect(matchesTab(ticket(status), 'solved')).toBe(true);
    }
    expect(matchesTab(ticket('OPEN'), 'all')).toBe(true);
  });
});
