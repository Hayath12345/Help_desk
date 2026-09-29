import { describe, expect, it } from 'vitest';
import { makeSummary } from '@/lib/tickets/test-fixtures';
import {
  appendToDraft,
  fillMacro,
  macroBody,
  macroContext,
  macroStatusPlan,
  macroTitle,
} from './macros';
import { normalizeTag, tagProblem } from './tags';

const macro = {
  titleEn: 'Engineer dispatched',
  titleAr: 'تم إرسال مهندس',
  bodyEn: 'Hi {{requesterFirstName}}, an engineer is on the way to {{ siteName }}.',
  bodyAr: '',
};

describe('macros', () => {
  it('picks the UI language, falling back to English when the Arabic text is empty', () => {
    expect(macroTitle(macro, 'ar')).toBe('تم إرسال مهندس');
    expect(macroTitle(macro, 'en')).toBe('Engineer dispatched');
    expect(macroBody(macro, 'ar')).toBe(macro.bodyEn);
  });

  it('fills {{requesterFirstName}} and {{siteName}} from the ticket', () => {
    const ticket = makeSummary();
    const context = macroContext(ticket, 'en');
    expect(context).toEqual({ requesterFirstName: 'Aisha', siteName: 'HMC – Building 3, Level 2' });
    expect(fillMacro(macro.bodyEn, context)).toBe(
      'Hi Aisha, an engineer is on the way to HMC – Building 3, Level 2.',
    );
    // No site: the client organisation stands in; unknown placeholders stay visible.
    const noSite = macroContext(makeSummary({ site: null }), 'en');
    expect(noSite.siteName).toBe('Hamad Medical Corporation');
    expect(fillMacro('{{siteName}} {{unknown}}', noSite)).toBe(
      'Hamad Medical Corporation {{unknown}}',
    );
  });

  it('appends to a draft with a blank line (design)', () => {
    expect(appendToDraft('', 'Hello')).toBe('Hello');
    expect(appendToDraft('Line one  \n', 'Hello')).toBe('Line one\n\nHello');
  });

  it('plans how a macro status is applied', () => {
    // A public reply already moves OPEN → PENDING: nothing extra to do.
    expect(
      macroStatusPlan({ current: 'OPEN', armed: 'PENDING', type: 'PUBLIC', andSolve: false }),
    ).toEqual({ andSolve: false, followUp: null });
    // An internal note leaves the status: PATCH it afterwards.
    expect(
      macroStatusPlan({ current: 'OPEN', armed: 'PENDING', type: 'INTERNAL', andSolve: false }),
    ).toEqual({ andSolve: false, followUp: 'PENDING' });
    // "Solved" on a public reply is Send & solve.
    expect(
      macroStatusPlan({ current: 'OPEN', armed: 'SOLVED', type: 'PUBLIC', andSolve: false }),
    ).toEqual({ andSolve: true, followUp: null });
    // Nothing armed, or a status staff can't set.
    expect(
      macroStatusPlan({ current: 'OPEN', armed: null, type: 'PUBLIC', andSolve: true }),
    ).toEqual({ andSolve: true, followUp: null });
    expect(
      macroStatusPlan({ current: 'OPEN', armed: 'CLOSED', type: 'INTERNAL', andSolve: false }),
    ).toEqual({ andSolve: false, followUp: null });
  });
});

describe('tags', () => {
  it('normalises typed tags like the design', () => {
    expect(normalizeTag('  Brute Force ')).toBe('brute-force');
    expect(normalizeTag('needs__parts  now')).toBe('needs-parts-now');
  });

  it('explains why a tag can’t be added', () => {
    expect(tagProblem('firewall', [])).toBeNull();
    expect(tagProblem('-x', [])).toBe('format');
    expect(tagProblem('é', [])).toBe('format');
    expect(tagProblem('a'.repeat(41), [])).toBe('tooLong');
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(tagProblem('another', twenty)).toBe('limit');
    expect(tagProblem('t3', twenty)).toBeNull();
  });
});
