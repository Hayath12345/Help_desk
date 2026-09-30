// Test helpers for the "SLA & escalation" sections (SLA policies, business hours & holidays,
// escalation rules, general settings): imported by *.test.tsx only. Renders with the admin,
// admin-sla, validation, common, errors and tickets messages, a fresh QueryClient and the page
// direction; plus a small fake of the API client that records calls.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import arSla from '@/messages/ar/admin-sla.json';
import arValidation from '@/messages/ar/validation.json';
import enSla from '@/messages/en/admin-sla.json';
import enValidation from '@/messages/en/validation.json';
import { KIT_MESSAGES } from '../../kit/kit-test-utils';

export { stubBrowserApis } from '../../kit/kit-test-utils';

export const SLA_MESSAGES = {
  en: { ...KIT_MESSAGES.en, 'admin-sla': enSla, validation: enValidation },
  ar: { ...KIT_MESSAGES.ar, 'admin-sla': arSla, validation: arValidation },
};

export function renderSla(
  ui: React.ReactElement,
  options: { locale?: 'en' | 'ar'; queryClient?: QueryClient } = {},
) {
  const locale = options.locale ?? 'en';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={SLA_MESSAGES[locale]}>
        <DirectionProvider dir={dir}>
          <div dir={dir} lang={locale}>
            {children}
          </div>
        </DirectionProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return { ...render(ui, { wrapper }), queryClient };
}

/** Opens a Radix select by keyboard and picks the option whose name starts with `label`. */
export async function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const option = await screen.findByRole('option', { name: new RegExp(`^${escaped}`) });
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

/** A JSON copy (what the fake API hands out, so tests can't mutate its state). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ApiCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** A later `updatedAt` for the fake API's writes. */
export function nextStamp(calls: number): string {
  return new Date(Date.parse('2026-09-29T12:00:00.000Z') + calls * 1000).toISOString();
}
