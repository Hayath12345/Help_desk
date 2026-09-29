// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import arTickets from '@/messages/ar/tickets.json';
import enTickets from '@/messages/en/tickets.json';
import { useAssetPlaceholder } from './i18n';

const LRI = '⁦';
const RLI = '⁧';
const PDI = '⁩';

function placeholderIn(locale: 'en' | 'ar') {
  const { result } = renderHook(() => useAssetPlaceholder(), {
    wrapper: ({ children }) => (
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        messages={{ tickets: locale === 'ar' ? arTickets : enTickets }}
      >
        {children}
      </NextIntlClientProvider>
    ),
  });
  return result.current;
}

describe('useAssetPlaceholder (UI-RR-2)', () => {
  it('isolates the translated Arabic example right-to-left, with the ID left-to-right inside', () => {
    const placeholder = placeholderIn('ar');
    expect(placeholder('e.g. FW-01')).toBe(`${RLI}مثال: ${LRI}FW-01${PDI}${PDI}`);
    // A digit-first ID keeps its order ("2026-018", not "018-2026").
    expect(placeholder('e.g. 2026-018')).toBe(`${RLI}مثال: ${LRI}2026-018${PDI}${PDI}`);
    expect(placeholder('Optional')).toBe(`${RLI}اختياري${PDI}`);
    // Configured in Arabic already: shown as is, right-to-left.
    expect(placeholder('مثال: CAM-014')).toBe(`${RLI}مثال: CAM-014${PDI}`);
  });

  it('isolates Latin text shown as configured left-to-right, so its punctuation stays at the end', () => {
    const placeholder = placeholderIn('ar');
    expect(placeholder('Serial on the label.')).toBe(`${LRI}Serial on the label.${PDI}`);
    expect(placeholder('e.g.')).toBe(`${LRI}e.g.${PDI}`);
  });

  it('leaves English as configured', () => {
    const placeholder = placeholderIn('en');
    expect(placeholder('e.g. FW-01')).toBe('e.g. FW-01');
    expect(placeholder('e.g. 2026-018')).toBe('e.g. 2026-018');
    expect(placeholder('Serial on the label.')).toBe('Serial on the label.');
    expect(placeholder(null)).toBeUndefined();
  });
});
