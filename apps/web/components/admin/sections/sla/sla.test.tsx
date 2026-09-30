// @vitest-environment jsdom
import type { SlaPolicyAdminDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { clone, nextStamp, renderSla, stubBrowserApis, type ApiCall } from './sla-test-utils';
import SlaSection from '.';

// SLA policies (E12): the four policies as a table (targets in the configured business-day
// length), the edit sheet with hours + minutes, the 1–99 at-risk rule, Save with
// expectedUpdatedAt (E19) and the stale 409 reload — against a fake /admin/sla.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  calls: [] as ApiCall[],
  items: [] as SlaPolicyAdminDto[],
  businessDayMinutes: 480,
  failNext: null as ApiRequestError | null,
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      return { items: clone(api.items), businessDayMinutes: api.businessDayMinutes };
    }),
    request: vi.fn(
      async (path: string, init: { method: string; json?: Record<string, unknown> }) => {
        api.calls.push({ method: init.method, path, body: init.json });
        if (api.failNext) {
          const error = api.failNext;
          api.failNext = null;
          throw error;
        }
        const priority = path.split('/').pop();
        const index = api.items.findIndex((p) => p.priority === priority);
        const { expectedUpdatedAt: _, ...values } = init.json as Record<string, unknown>;
        api.items[index] = {
          ...api.items[index]!,
          ...values,
          updatedAt: nextStamp(api.calls.length),
        };
        return { item: clone(api.items[index]) };
      },
    ),
  },
}));

function policy(
  priority: SlaPolicyAdminDto['priority'],
  first: number,
  resolve: number,
): SlaPolicyAdminDto {
  return {
    id: `00000000-0000-4000-8000-00000000000${priority.slice(1)}`,
    priority,
    firstReplyMins: first,
    resolveMins: resolve,
    businessHoursOnly: priority !== 'P1',
    atRiskPercent: 75,
    updatedAt: '2026-09-23T12:00:00.000Z',
  };
}

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.businessDayMinutes = 480;
  api.items = [
    policy('P1', 15, 240),
    policy('P2', 60, 480),
    policy('P3', 240, 960),
    policy('P4', 480, 2400),
  ];
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const table = () => screen.findByRole('table', { name: 'SLA policies' });
const rowOf = async (label: RegExp) => {
  const t = await table();
  return waitFor(() => {
    const row = within(t)
      .getAllByRole('row')
      .find((r) => label.test(r.textContent ?? ''));
    if (!row) throw new Error(`no row ${label}`);
    return row;
  });
};

describe('SLA policies section', () => {
  it('lists the four policies with targets in the configured business-day length', async () => {
    renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    const p2 = await rowOf(/P2/);
    // 480 business minutes = one 8-hour business day here (not 8 hours on a 9-hour day).
    expect(within(p2).getByText('1 business day')).toBeTruthy();
    expect(within(await rowOf(/P1/)).getByText('24/7')).toBeTruthy();
    expect(within(await rowOf(/P4/)).getByText('5 business days')).toBeTruthy();
    expect(screen.getByText(/Open tickets keep the due dates/)).toBeTruthy();
    expect(screen.getByText(/Only Super Admins can open this section/)).toBeTruthy();
    // No "Create new": the four policies are fixed.
    expect(screen.queryByRole('button', { name: /Create new/ })).toBeNull();
  });

  it('edits the targets as hours + minutes and saves them with expectedUpdatedAt', async () => {
    renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(within(await rowOf(/P3/)).getByRole('button'));
    const sheet = await screen.findByRole('dialog', { name: 'P3 Medium targets' });
    const first = within(sheet).getByRole('group', { name: /^First reply within/ });
    const [hours, minutes] = within(first).getAllByRole('textbox');
    expect((hours as HTMLInputElement).value).toBe('4');
    fireEvent.change(hours!, { target: { value: '1' } });
    fireEvent.change(minutes!, { target: { value: '30' } });
    expect(within(sheet).getByText('Shown to clients as: 1 h 30 min')).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText(/Flag as at risk after/), {
      target: { value: '80' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(api.calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/admin/sla/P3',
      body: {
        expectedUpdatedAt: '2026-09-23T12:00:00.000Z',
        firstReplyMins: 90,
        resolveMins: 960,
        businessHoursOnly: true,
        atRiskPercent: 80,
      },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('P3 Medium targets saved');
  });

  it('refuses zero minutes and an at-risk share outside 1–99 before sending', async () => {
    renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(within(await rowOf(/P2/)).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    const [hours, minutes] = within(
      within(sheet).getByRole('group', { name: /^Resolve within/ }),
    ).getAllByRole('textbox');
    fireEvent.change(hours!, { target: { value: '0' } });
    fireEvent.change(minutes!, { target: { value: '0' } });
    fireEvent.change(within(sheet).getByLabelText(/Flag as at risk after/), {
      target: { value: '100' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Allow at least 1 minute.')).toBeTruthy();
    expect(within(sheet).getByText('Use a whole percentage from 1 to 99.')).toBeTruthy();
    fireEvent.change(hours!, { target: { value: '1.5' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Use whole numbers.')).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('shows "Someone else changed this — reload" on a stale 409 and reloads the row', async () => {
    renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(within(await rowOf(/P4/)).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('switch'));
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'changed', undefined, {
      reason: 'stale',
      currentUpdatedAt: '2026-09-29T10:00:00.000Z',
    });
    // Someone else's save: the reload brings it.
    api.items[3] = { ...api.items[3]!, resolveMins: 1200, updatedAt: '2026-09-29T10:00:00.000Z' };
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(sheet).queryByText('Someone else changed this — reload')).toBeNull(),
    );
    const [hours] = within(
      within(sheet).getByRole('group', { name: /^Resolve within/ }),
    ).getAllByRole('textbox');
    await waitFor(() => expect((hours as HTMLInputElement).value).toBe('20'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toMatchObject({
        expectedUpdatedAt: '2026-09-29T10:00:00.000Z',
        resolveMins: 1200,
      }),
    );
  });

  it('keeps the version the edit started from when a newer one arrives meanwhile (E19)', async () => {
    const { queryClient } = renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(within(await rowOf(/P2/)).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText(/Flag as at risk after/), {
      target: { value: '70' },
    });
    // Another admin saves P2; this tab refetches (config:updated).
    api.items[1] = { ...api.items[1]!, firstReplyMins: 45, updatedAt: '2026-09-29T09:00:00.000Z' };
    await queryClient.invalidateQueries({ queryKey: ['admin', 'sla'] });
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'GET').length).toBe(2));
    // The typed value stays, and the save still says which version it started from → 409 stale.
    expect((within(sheet).getByLabelText(/Flag as at risk after/) as HTMLInputElement).value).toBe(
      '70',
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        expectedUpdatedAt: '2026-09-23T12:00:00.000Z',
        atRiskPercent: 70,
      }),
    );
  });

  it('loads a newer version into an untouched sheet', async () => {
    const { queryClient } = renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(within(await rowOf(/P2/)).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    api.items[1] = { ...api.items[1]!, firstReplyMins: 120, updatedAt: '2026-09-29T09:00:00.000Z' };
    await queryClient.invalidateQueries({ queryKey: ['admin', 'sla'] });
    const [hours] = within(
      within(sheet).getByRole('group', { name: /^First reply within/ }),
    ).getAllByRole('textbox');
    await waitFor(() => expect((hours as HTMLInputElement).value).toBe('2'));
    fireEvent.change(within(sheet).getByLabelText(/Flag as at risk after/), {
      target: { value: '60' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
        expectedUpdatedAt: '2026-09-29T09:00:00.000Z',
        firstReplyMins: 120,
      }),
    );
  });

  it('renders in Arabic, right to left', async () => {
    renderSla(<SlaSection role="SUPER_ADMIN" userId="u1" />, { locale: 'ar' });
    const arTable = await screen.findByRole('table');
    await waitFor(() => expect(within(arTable).getAllByRole('row').length).toBe(5));
    expect(within(arTable).getAllByText('ساعات العمل').length).toBeGreaterThan(0);
    expect(within(arTable).getByText('على مدار الساعة')).toBeTruthy();
    expect(screen.getByText(/تحتفظ التذاكر المفتوحة/)).toBeTruthy();
    const firstRow = within(arTable).getAllByRole('row')[1]!;
    fireEvent.click(within(firstRow).getByRole('button'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('group', { name: /^الرد الأول خلال/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'حفظ' })).toBeTruthy();
    expect(sheet.closest('[dir="rtl"]') ?? document.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});
