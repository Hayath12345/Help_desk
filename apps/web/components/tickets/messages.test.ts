import { IMPACTS, TICKET_LIMITS, TICKET_TYPES, CONTRACT_TYPES } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';

type Tree = { [key: string]: string | Tree };

const leafKeys = (tree: Tree, prefix = ''): string[] =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
const leafValues = (tree: Tree): string[] =>
  Object.values(tree).flatMap((value) => (typeof value === 'string' ? [value] : leafValues(value)));

describe('tickets / validation message catalogues', () => {
  for (const [ns, en, ar] of [
    ['tickets', enTickets, arTickets],
    ['validation', enValidation, arValidation],
  ] as const) {
    it(`${ns}: English and Arabic define the same keys, none empty`, () => {
      expect(leafKeys(ar as Tree).sort()).toEqual(leafKeys(en as Tree).sort());
      for (const value of [...leafValues(en as Tree), ...leafValues(ar as Tree)]) {
        expect(value.trim()).not.toBe('');
      }
    });
  }

  it('labels every ticket type, impact and contract type', () => {
    for (const type of TICKET_TYPES) expect(arTickets.type[type]).toBeTruthy();
    for (const impact of IMPACTS) expect(arTickets.impact[impact]).toBeTruthy();
    for (const contract of CONTRACT_TYPES) expect(arTickets.contract[contract]).toBeTruthy();
  });

  it('has the contract validation keys, with the real description minimum', () => {
    for (const key of [
      'subjectRequired',
      'descriptionMin',
      'messageRequired',
      'tagFormat',
    ] as const) {
      expect(enValidation[key]).toBeTruthy();
      expect(arValidation[key]).toBeTruthy();
    }
    expect(enValidation.descriptionMin).toContain(String(TICKET_LIMITS.descriptionMin));
    expect(arValidation.descriptionMin).toContain(String(TICKET_LIMITS.descriptionMin));
  });

  it('keeps the Arabic product name consistent', () => {
    for (const value of leafValues(arTickets as Tree))
      expect(value).not.toContain('Loons Help Desk');
  });
});
