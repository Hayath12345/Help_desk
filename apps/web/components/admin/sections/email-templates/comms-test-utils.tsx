// Test helpers for the Communication sections (email templates, help center, audit log):
// imported by *.test.tsx only. Renders with the admin, admin-comms, validation, common, errors
// and tickets messages, a fresh QueryClient and the page direction.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import arComms from '@/messages/ar/admin-comms.json';
import arValidation from '@/messages/ar/validation.json';
import enComms from '@/messages/en/admin-comms.json';
import enValidation from '@/messages/en/validation.json';
import { KIT_MESSAGES } from '../../kit/kit-test-utils';

export { stubBrowserApis } from '../../kit/kit-test-utils';

export const COMMS_MESSAGES = {
  en: { ...KIT_MESSAGES.en, 'admin-comms': enComms, validation: enValidation },
  ar: { ...KIT_MESSAGES.ar, 'admin-comms': arComms, validation: arValidation },
};

export function renderComms(ui: React.ReactElement, options: { locale?: 'en' | 'ar' } = {}) {
  const locale = options.locale ?? 'en';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        messages={COMMS_MESSAGES[locale]}
      >
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

/** A JSON-able copy (what the fake API hands out, so tests can't mutate its state). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
