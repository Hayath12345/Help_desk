import { describe, expect, it } from 'vitest';
import {
  canonicalTicketRef,
  isTicketTab,
  matchesTab,
  portalListFilters,
  portalTicketHref,
  sortByRecent,
} from './types';

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
      expect(matchesTab({ status }, 'active')).toBe(true);
      expect(matchesTab({ status }, 'solved')).toBe(false);
    }
    for (const status of ['SOLVED', 'CLOSED'] as const) {
      expect(matchesTab({ status }, 'active')).toBe(false);
      expect(matchesTab({ status }, 'solved')).toBe(true);
    }
    expect(matchesTab({ status: 'OPEN' }, 'all')).toBe(true);
  });

  it('asks the API for the client’s own tickets of a tab, newest activity first', () => {
    expect(portalListFilters('active')).toEqual({ tab: 'active', scope: 'mine', sort: 'recent' });
  });
});

describe('sortByRecent', () => {
  it('orders by updatedAt descending and keeps the API order for ties', () => {
    const rows = [
      { id: 'a', updatedAt: '2026-09-23T10:00:00.000Z' },
      { id: 'b', updatedAt: '2026-09-23T12:00:00.000Z' },
      { id: 'c', updatedAt: '2026-09-23T10:00:00.000Z' },
      { id: 'd', updatedAt: '2026-09-24T08:00:00.000Z' },
    ];
    expect(sortByRecent(rows).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']); // not mutated
  });
});

describe('ticket references', () => {
  it('links rows to /tickets/LG-n', () => {
    expect(portalTicketHref({ ref: 'LG-4771', number: 4771 })).toBe('/tickets/LG-4771');
    expect(portalTicketHref({ ref: 'odd', number: 12 })).toBe('/tickets/LG-12');
  });

  it('normalises the [ref] segment and rejects anything else', () => {
    expect(canonicalTicketRef('LG-4771')).toBe('LG-4771');
    expect(canonicalTicketRef('lg-4771')).toBe('LG-4771');
    expect(canonicalTicketRef(' 4771 ')).toBe('LG-4771');
    expect(canonicalTicketRef('00000000-0000-4000-8000-00000000ABCD')).toBe(
      '00000000-0000-4000-8000-00000000abcd',
    );
    expect(canonicalTicketRef('LG-')).toBeNull();
    expect(canonicalTicketRef('../admin')).toBeNull();
    expect(canonicalTicketRef('LG-12x')).toBeNull();
  });
});
