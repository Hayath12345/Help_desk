import { describe, expect, it } from 'vitest';
import { normalizeE164 } from './phone.ts';

describe('normalizeE164 (D11)', () => {
  it('accepts international numbers written the usual ways', () => {
    expect(normalizeE164('+974 5550 1000')).toBe('+97455501000');
    expect(normalizeE164('00974-5550-1000')).toBe('+97455501000');
    expect(normalizeE164('+44 (0)20 7946 0000')).toBe('+442079460000');
    expect(normalizeE164(' +1 (415) 555.0100 ')).toBe('+14155550100');
    expect(normalizeE164('+974/5550/1000')).toBe('+97455501000');
  });

  it('reads Arabic-Indic digits and ignores direction marks', () => {
    expect(normalizeE164('‏+٩٧٤ ٥٥٥٠ ١٠٠٠')).toBe('+97455501000');
    expect(normalizeE164('+۹۷۴۵۵۵۰۱۰۰۰')).toBe('+97455501000');
  });

  it('refuses local numbers, junk and impossible lengths', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '5550 1000',
      '055501000',
      '+0 5550 1000',
      '+974 555',
      '+97455501000123456',
      '+974 5550 1000 ext 12',
      'call me',
    ]) {
      expect(normalizeE164(bad), String(bad)).toBeNull();
    }
  });
});
