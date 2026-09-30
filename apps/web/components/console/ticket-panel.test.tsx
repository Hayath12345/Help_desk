// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomFieldValue, TicketDetailDto } from '@loons/shared';
import { ticketKeys } from '@/lib/tickets/keys';
import {
  FORM_CONFIG,
  FORM_CONTEXT,
  IDS,
  TEAMS,
  fixtureId,
  makeDetail,
} from '@/lib/tickets/test-fixtures';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import { formatCustomFieldValue } from './custom-field-values';
import { TicketPanel } from './ticket-panel';

// The console right panel with archived config (decision E6): custom-field values with their
// labels and "archived" markers, archived site / team markers, and a ticket on an archived team
// stays workable (its members are offered from GET /teams?archived=include).

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/browser')>();
  return { ...actual, apiClient: { ...actual.apiClient, get: api.get } };
});

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});
beforeEach(() => {
  api.get.mockReset();
});
afterEach(cleanup);

const MESSAGES = {
  en: { common: enCommon, console: enConsole, tickets: enTickets, errors: enErrors },
  ar: { common: arCommon, console: arConsole, tickets: arTickets, errors: arErrors },
};

const MEMBER = { id: fixtureId(811), name: 'Rami Member', role: 'AGENT' as const };

function field(overrides: Partial<CustomFieldValue>): CustomFieldValue {
  return {
    key: 'f',
    labelEn: 'Field',
    labelAr: 'حقل',
    type: 'TEXT',
    value: 'x',
    isActive: true,
    options: null,
    ...overrides,
  };
}

function renderPanel(ticket: TicketDetailDto, locale: 'en' | 'ar' = 'en') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(ticketKeys.formConfig(), FORM_CONFIG);
  queryClient.setQueryData(ticketKeys.formContext(ticket.requester.id), FORM_CONTEXT);
  // Active teams only: the ticket's team is archived, so it isn't here.
  queryClient.setQueryData(ticketKeys.teams(), [{ ...TEAMS.soc, members: [] }]);
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={{ id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' }}>
          <TicketPanel ticket={ticket} />
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe('TicketPanel with archived config (E6)', () => {
  it('shows custom-field values in form order with labels and archived markers', () => {
    renderPanel(
      makeDetail({
        customFields: [
          field({ key: 'cam', labelEn: 'Camera ID', type: 'ASSET_ID', value: 'CAM-014' }),
          field({
            key: 'side',
            labelEn: 'Door side',
            type: 'DROPDOWN',
            value: 'left',
            options: [{ value: 'left', labelEn: 'Left', labelAr: 'يسار', isActive: false }],
          }),
          field({ key: 'old', labelEn: 'Legacy', value: 'kept', isActive: false }),
          field({ key: 'ok', labelEn: 'Escorted', type: 'YES_NO', value: true }),
        ],
      }),
    );
    const section = screen.getByRole('region', { name: 'Custom fields' });
    const terms = within(section)
      .getAllByRole('term')
      .map((t) => t.textContent);
    const values = within(section)
      .getAllByRole('definition')
      .map((d) => d.textContent);
    expect(terms).toEqual(['Camera ID', 'Door side', 'Legacy (archived)', 'Escorted']);
    expect(values).toEqual(['CAM-014', 'Left (archived)', 'kept', 'Yes']);
  });

  it('shows nothing extra when the ticket holds no custom fields', () => {
    renderPanel(makeDetail());
    expect(screen.queryByRole('region', { name: 'Custom fields' })).toBeNull();
  });

  it('a ticket on an archived team still offers that team’s members, marked archived', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/teams?archived=include') {
        return {
          items: [
            { ...TEAMS.soc, members: [] },
            { ...TEAMS.elv, members: [MEMBER] },
          ],
        };
      }
      throw new Error(`unexpected GET ${String(path)}`);
    });
    renderPanel(
      makeDetail({
        team: { ...TEAMS.elv, isActive: false },
        site: { id: fixtureId(799), name: 'Old Wing', nameAr: null, isActive: false },
      }),
    );
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/teams?archived=include', expect.anything()),
    );
    const assignee = screen.getByRole('combobox', { name: /Assignee/ });
    act(() => assignee.focus());
    fireEvent.keyDown(assignee, { key: 'Enter' });
    expect(
      await screen.findByRole('option', { name: 'Rami Member · ELV Field (archived)' }),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('option', { name: /Rami Member/ }), { key: 'Escape' });
    // The archived site keeps its name, marked.
    expect(screen.getByRole('combobox', { name: /Site/ }).textContent).toBe('Old Wing (archived)');
  });

  it('an active team uses the plain team list (no archived request)', () => {
    renderPanel(makeDetail({ team: { ...TEAMS.soc, isActive: true } }));
    expect(api.get).not.toHaveBeenCalled();
  });

  it('Arabic: labels, markers and Yes/No in Arabic', () => {
    renderPanel(
      makeDetail({
        customFields: [
          field({
            key: 'old',
            labelEn: 'Legacy',
            labelAr: 'قديم',
            value: false,
            type: 'YES_NO',
            isActive: false,
          }),
        ],
      }),
      'ar',
    );
    const section = screen.getByRole('region', { name: 'الحقول المخصصة' });
    expect(within(section).getByRole('term').textContent).toBe('قديم (مؤرشف)');
    expect(within(section).getByRole('definition').textContent).toBe(arTickets.no);
  });
});

describe('formatCustomFieldValue', () => {
  const words = { yes: 'Yes', no: 'No', archived: (l: string) => `${l} (archived)` };
  it('formats every type', () => {
    expect(formatCustomFieldValue(field({ type: 'NUMBER', value: 12 }), 'en', words)).toBe('12');
    expect(formatCustomFieldValue(field({ type: 'DATE', value: '2026-09-29' }), 'en', words)).toBe(
      'Sep 29, 2026',
    );
    expect(
      formatCustomFieldValue(
        field({
          type: 'MULTI_SELECT',
          value: ['a', 'b'],
          options: [
            { value: 'a', labelEn: 'A', labelAr: 'أ', isActive: true },
            { value: 'b', labelEn: 'B', labelAr: 'ب', isActive: false },
          ],
        }),
        'ar',
        words,
      ),
    ).toBe('أ, ب (archived)');
    expect(formatCustomFieldValue(field({ value: '' }), 'en', words)).toBe('—');
  });
});
