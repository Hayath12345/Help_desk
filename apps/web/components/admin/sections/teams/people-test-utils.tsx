// Test helpers for the People & clients sections (imported by *.test.tsx only): an in-memory
// admin API behind `apiClient` (answers are parsed with the real contract schemas), the messages
// the sections use, and small interaction helpers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect, vi } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import { ApiRequestError } from '@/lib/api/errors';
import arAdminPeople from '@/messages/ar/admin-people.json';
import arAdmin from '@/messages/ar/admin.json';
import arCommon from '@/messages/ar/common.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enAdminPeople from '@/messages/en/admin-people.json';
import enAdmin from '@/messages/en/admin.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';

export const PEOPLE_MESSAGES = {
  en: {
    admin: enAdmin,
    'admin-people': enAdminPeople,
    common: enCommon,
    errors: enErrors,
    tickets: enTickets,
    validation: enValidation,
  },
  ar: {
    admin: arAdmin,
    'admin-people': arAdminPeople,
    common: arCommon,
    errors: arErrors,
    tickets: arTickets,
    validation: arValidation,
  },
};

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (call: ApiCall) => unknown;

/**
 * The fake admin API: `on('GET /admin/teams', handler)`; a handler returns the JSON answer or
 * throws (e.g. `conflict(...)`). Unknown routes answer 404.
 */
export function createFakeApi() {
  const routes = new Map<string, Handler>();
  const calls: ApiCall[] = [];
  const handle = async (method: string, url: string, body?: unknown) => {
    const [path = '', search = ''] = url.split('?');
    const call = { method, path, query: new URLSearchParams(search), body };
    calls.push(call);
    await Promise.resolve();
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new ApiRequestError(404, 'NOT_FOUND', `no route ${method} ${path}`);
    return handler(call);
  };
  return {
    calls,
    on(route: string, handler: Handler) {
      routes.set(route, handler);
    },
    /** Calls other than GET. */
    writes: () => calls.filter((c) => c.method !== 'GET'),
    client: {
      get: (url: string) => handle('GET', url),
      request: (url: string, init: { method: string; json?: unknown }) =>
        handle(init.method, url, init.json),
    },
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;

export const conflict = (details: Record<string, unknown>) =>
  new ApiRequestError(409, 'CONFLICT', 'conflict', undefined, details);

export const invalid = (issues: Array<{ path: Array<string | number>; message: string }>) =>
  new ApiRequestError(
    400,
    'VALIDATION_FAILED',
    'invalid',
    undefined,
    issues.map((i) => ({ ...i, location: 'body', code: 'custom' })),
  );

/** What Radix and cmdk need from a browser that jsdom lacks (call in beforeAll). */
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

/** Renders a section with the People messages, a fresh QueryClient and the page direction. */
export function renderSection(ui: React.ReactElement, locale: 'en' | 'ar' = 'en') {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        messages={PEOPLE_MESSAGES[locale]}
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

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Sets an input's value the way a user edit does. */
export function type(el: HTMLElement, value: string): void {
  fireEvent.change(el, { target: { value } });
}

/** Opens a Combobox, clicks the option whose name starts with `label`, waits for it to close. */
export async function pick(trigger: HTMLElement, label: string): Promise<void> {
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(label)}`) }),
  );
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

/** Waits for the queries and effects started by the last interaction. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
