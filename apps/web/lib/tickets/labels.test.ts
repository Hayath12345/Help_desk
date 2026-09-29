import { describe, expect, it } from 'vitest';
import { hasArabic, localizedAssetPlaceholder } from './labels';

const LRI = '\u2066';
const PDI = '\u2069';
/** The example ID as it is kept inside the Arabic words: left-to-right isolated. */
const id = (text: string) => `${LRI}${text}${PDI}`;

const AR = { example: (id: string) => `مثال: ${id}`, optional: 'اختياري' };
const EN = { example: (id: string) => `e.g. ${id}`, optional: 'Optional' };

describe('localizedAssetPlaceholder (DA-11)', () => {
  it('shows the configured English text as is in English', () => {
    expect(localizedAssetPlaceholder('e.g. FW-01', 'en', EN)).toBe('e.g. FW-01');
    expect(localizedAssetPlaceholder('Optional', 'en', EN)).toBe('Optional');
  });

  it('translates the words around the example ID in Arabic and keeps the ID', () => {
    expect(localizedAssetPlaceholder('e.g. FW-01', 'ar', AR)).toBe(`مثال: ${id('FW-01')}`);
    expect(localizedAssetPlaceholder('e.g. AMC-2026-018', 'ar', AR)).toBe(
      `مثال: ${id('AMC-2026-018')}`,
    );
    expect(localizedAssetPlaceholder('E.g. MR-2.14', 'ar', AR)).toBe(`مثال: ${id('MR-2.14')}`);
    expect(localizedAssetPlaceholder('Optional', 'ar', AR)).toBe('اختياري');
  });

  it('keeps an example that starts with digits in its configured order (UI-RR-2)', () => {
    // Without the isolate, "2026" and "018" read as Arabic numbers after "مثال: " and the '-'
    // between them resolves right-to-left: "018-2026".
    expect(localizedAssetPlaceholder('e.g. 2026-018', 'ar', AR)).toBe(`مثال: ${id('2026-018')}`);
    expect(localizedAssetPlaceholder('e.g. 2026-018', 'en', EN)).toBe('e.g. 2026-018');
  });

  it('falls back to the configured text for other shapes, Arabic text or nothing', () => {
    expect(localizedAssetPlaceholder('Serial on the label', 'ar', AR)).toBe('Serial on the label');
    expect(localizedAssetPlaceholder('مثال: CAM-014', 'ar', AR)).toBe('مثال: CAM-014');
    expect(localizedAssetPlaceholder('e.g.', 'ar', AR)).toBe('e.g.');
    expect(localizedAssetPlaceholder(null, 'ar', AR)).toBeUndefined();
    expect(localizedAssetPlaceholder('  ', 'en', EN)).toBeUndefined();
  });

  it('tells Arabic text from Latin text', () => {
    expect(hasArabic(`مثال: ${id('FW-01')}`)).toBe(true);
    expect(hasArabic('Serial on the label.')).toBe(false);
    expect(hasArabic('2026-018')).toBe(false);
  });
});
