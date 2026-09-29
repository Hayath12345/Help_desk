import { describe, expect, it } from 'vitest';
import { e2eTicketWhere, e2eUserWhere, isE2eTicket, isE2eUserEmail } from './e2e-users.ts';

describe('E2E user and ticket patterns (cleanup-e2e)', () => {
  it('matches only the addresses the Playwright suite generates', () => {
    for (const email of [
      'e2e-1790000000000@hamad.qa',
      'pending.1790000000000@unmatched-e2e.test',
    ]) {
      expect(isE2eUserEmail(email), email).toBe(true);
    }
    for (const email of [
      'aisha.alkuwari@hamad.qa', // seeded demo client
      'e2e-1@hamad.qa.example', // different domain
      'x.e2e-1@hamad.qa', // prefix not at the start
      'e2e-@hamad.qa', // nothing generated
      'e2e-1@loonsgroup.com',
      'pending.1@unmatched.test',
    ]) {
      expect(isE2eUserEmail(email), email).toBe(false);
    }
  });

  it('the database filter is limited to clients and to both parts of each pattern', () => {
    expect(e2eUserWhere()).toEqual({
      role: 'CLIENT',
      OR: [
        { AND: [{ email: { startsWith: 'e2e-' } }, { email: { endsWith: '@hamad.qa' } }] },
        {
          AND: [
            { email: { startsWith: 'pending.' } },
            { email: { endsWith: '@unmatched-e2e.test' } },
          ],
        },
      ],
    });
  });

  it('matches only tickets the suite raises: a generated subject AND a suite account', () => {
    const subject = '[e2e:1790000000000] VPN tunnel drops every few minutes';
    expect(isE2eTicket({ subject, requesterEmail: 'aisha.alkuwari@hamad.qa' })).toBe(true);
    expect(isE2eTicket({ subject, requesterEmail: 'Aisha.AlKuwari@hamad.qa' })).toBe(true);
    for (const [s, email] of [
      [subject, 'khalid.mansouri@qnb.com'], // another client
      [subject, 'maya.ruiz@loonsgroup.com'],
      ['VPN tunnel drops every few minutes', 'aisha.alkuwari@hamad.qa'], // a real ticket
      ['[e2e:] VPN tunnel drops', 'aisha.alkuwari@hamad.qa'], // nothing generated
      ['[e2e:123] VPN tunnel drops', 'aisha.alkuwari@hamad.qa'], // not a timestamp
      ['[e2e:1790000000000]VPN', 'aisha.alkuwari@hamad.qa'], // no separator
      ['Re: [e2e:1790000000000] VPN', 'aisha.alkuwari@hamad.qa'], // prefix not at the start
    ] as const) {
      expect(isE2eTicket({ subject: s, requesterEmail: email }), `${s} / ${email}`).toBe(false);
    }
  });

  it('the ticket filter needs both the subject prefix and a suite client account', () => {
    expect(e2eTicketWhere()).toEqual({
      subject: { startsWith: '[e2e:' },
      requester: { role: 'CLIENT', email: { in: ['aisha.alkuwari@hamad.qa'] } },
    });
  });
});
