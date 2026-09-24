import { describe, expect, it } from 'vitest';
import { e2eUserWhere, isE2eUserEmail } from './e2e-users.ts';

describe('E2E user patterns (cleanup-e2e)', () => {
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
});
