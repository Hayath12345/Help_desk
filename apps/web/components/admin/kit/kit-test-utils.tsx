// Test helpers for the admin kit (imported by *.test.tsx only).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { vi } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import arAdmin from '@/messages/ar/admin.json';
import arCommon from '@/messages/ar/common.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import enAdmin from '@/messages/en/admin.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';

export const KIT_MESSAGES = {
  en: { admin: enAdmin, common: enCommon, errors: enErrors, tickets: enTickets },
  ar: { admin: arAdmin, common: arCommon, errors: arErrors, tickets: arTickets },
};

/** What Radix needs from a browser that jsdom lacks (call in beforeAll). */
export function stubBrowserApis(): void {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
}

/** Renders `ui` with the admin / tickets / common / errors messages, a QueryClient and the direction. */
export function renderKit(ui: React.ReactElement, options: { locale?: 'en' | 'ar' } = {}) {
  const locale = options.locale ?? 'en';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={KIT_MESSAGES[locale]}>
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
