// Test helpers for the Ticket setup sections (imported by *.test.tsx only): an in-memory fake of
// the API client, contract-valid rows, and a renderer with the messages, a QueryClient (form
// config and teams pre-loaded) and the viewer.

import {
  categoryAdminDtoSchema,
  customFieldAdminDtoSchema,
  macroAdminDtoSchema,
  type CategoryAdminDto,
  type CustomFieldAdminDto,
  type MacroAdminDto,
  type Role,
} from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect, vi } from 'vitest';
import { DirectionProvider } from '@/components/ui/direction';
import { ApiRequestError } from '@/lib/api/errors';
import { ticketKeys } from '@/lib/tickets/keys';
import { FORM_CONFIG, TEAMS, fixtureId } from '@/lib/tickets/test-fixtures';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arAdmin from '@/messages/ar/admin.json';
import arSetup from '@/messages/ar/admin-setup.json';
import arCommon from '@/messages/ar/common.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enAdmin from '@/messages/en/admin.json';
import enSetup from '@/messages/en/admin-setup.json';
import enCommon from '@/messages/en/common.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';

export const SETUP_MESSAGES = {
  en: {
    admin: enAdmin,
    'admin-setup': enSetup,
    common: enCommon,
    errors: enErrors,
    tickets: enTickets,
    validation: enValidation,
  },
  ar: {
    admin: arAdmin,
    'admin-setup': arSetup,
    common: arCommon,
    errors: arErrors,
    tickets: arTickets,
    validation: arValidation,
  },
};

export type Handler = (body: unknown, match: RegExpMatchArray) => unknown;

/** A tiny router standing in for the API: `on(method, /path/, reply)`, calls recorded. */
export class FakeApi {
  routes: Array<{ method: string; path: RegExp; reply: Handler }> = [];
  calls: Array<{ method: string; path: string; body: unknown }> = [];

  on(method: string, path: RegExp, reply: Handler | unknown): this {
    // Newest first, so a test can override a default route.
    this.routes.unshift({
      method,
      path,
      reply: typeof reply === 'function' ? (reply as Handler) : () => reply,
    });
    return this;
  }

  async handle(method: string, path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    for (const route of this.routes) {
      const match = route.method === method ? path.match(route.path) : null;
      if (match) return structuredClone(await route.reply(body, match));
    }
    throw new ApiRequestError(404, 'NOT_FOUND', `no fake route for ${method} ${path}`);
  }

  /** Bodies sent to `method` + `path`. */
  sent(method: string, path: RegExp): unknown[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path)).map((c) => c.body);
  }

  reset(): void {
    this.routes = [];
    this.calls = [];
  }
}

/** An API error as the client raises it. */
export function apiError(status: number, code: string, details?: unknown): ApiRequestError {
  return new ApiRequestError(status, code as never, code, 'req-test', details);
}

export const stale = () =>
  apiError(409, 'CONFLICT', { reason: 'stale', currentUpdatedAt: '2026-09-29T12:00:00.000Z' });

/** Teams as GET /teams returns them (with members). */
export const TEAM_LIST = Object.values(TEAMS).map((team) => ({ ...team, members: [] }));

const T0 = '2026-09-29T10:00:00.000Z';

export function subtypeRow(
  n: number,
  categoryId: string,
  overrides: Partial<CategoryAdminDto['subtypes'][number]> = {},
): CategoryAdminDto['subtypes'][number] {
  return {
    id: fixtureId(3000 + n),
    categoryId,
    key: `kind-${n}`,
    labelEn: `Kind ${n}`,
    labelAr: `نوع ${n}`,
    defaultPriority: 'P3',
    sortOrder: n,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function categoryRow(
  n: number,
  overrides: Partial<CategoryAdminDto> = {},
): CategoryAdminDto {
  const id = fixtureId(2000 + n);
  return categoryAdminDtoSchema.parse({
    id,
    key: `category-${n}`,
    labelEn: `Category ${n}`,
    labelAr: `فئة ${n}`,
    icon: 'cctv',
    assetPlaceholder: 'e.g. CAM-014',
    assetPlaceholderAr: null,
    team: { ...TEAMS.elv, isActive: true },
    sortOrder: n,
    isActive: true,
    isSecurityCategory: false,
    hiddenReason: null,
    subtypes: [subtypeRow(n * 10, id), subtypeRow(n * 10 + 1, id, { defaultPriority: 'P1' })],
    fields: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

export function fieldRow(
  n: number,
  overrides: Partial<CustomFieldAdminDto> = {},
): CustomFieldAdminDto {
  return customFieldAdminDtoSchema.parse({
    id: fixtureId(4000 + n),
    key: `field_${n}`,
    labelEn: `Field ${n}`,
    labelAr: `حقل ${n}`,
    type: 'TEXT',
    options: [],
    placeholderEn: null,
    placeholderAr: null,
    required: false,
    isActive: true,
    categories: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

export function macroRow(n: number, overrides: Partial<MacroAdminDto> = {}): MacroAdminDto {
  return macroAdminDtoSchema.parse({
    id: fixtureId(5000 + n),
    key: `macro-${n}`,
    teamId: null,
    team: null,
    titleEn: `Macro ${n}`,
    titleAr: `رد ${n}`,
    bodyEn: `Hello {{requesterFirstName}} ${n}`,
    bodyAr: '',
    setStatus: null,
    sortOrder: n,
    isActive: true,
    createdBy: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

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

export function renderSetup(
  ui: React.ReactElement,
  options: { locale?: 'en' | 'ar'; role?: Role; userId?: string } = {},
) {
  const locale = options.locale ?? 'en';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryDefaults(ticketKeys.formConfig(), { staleTime: Infinity });
  queryClient.setQueryDefaults(ticketKeys.teams(), { staleTime: Infinity });
  queryClient.setQueryData(ticketKeys.formConfig(), FORM_CONFIG);
  queryClient.setQueryData(ticketKeys.teams(), TEAM_LIST);
  const viewer = {
    id: options.userId ?? fixtureId(801),
    name: 'Sam Admin',
    role: options.role ?? ('SUPER_ADMIN' as Role),
  };
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        messages={SETUP_MESSAGES[locale]}
      >
        <DirectionProvider dir={dir}>
          <ViewerProvider viewer={viewer}>
            <div dir={dir} lang={locale}>
              {ui}
            </div>
          </ViewerProvider>
        </DirectionProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Opens a Radix select with the keyboard and picks the option whose text starts with `label`. */
export async function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const option = await screen.findByRole('option', { name: new RegExp(`^${escapeRe(label)}`) });
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

export const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
