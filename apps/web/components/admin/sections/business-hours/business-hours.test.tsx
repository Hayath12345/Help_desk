// @vitest-environment jsdom
import type { BusinessHoursDto, HolidayAdminDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import {
  choose,
  clone,
  nextStamp,
  renderSla,
  stubBrowserApis,
  type ApiCall,
} from '../sla/sla-test-utils';
import BusinessHoursSection from '.';

// Business hours & holidays (E12): the working week saved as a whole with each day's
// expectedUpdatedAt, open < close and at least one open day, the stale 409; holidays by year,
// add / rename / archive / restore, and an existing (archived) date offered for restore instead of
// being added twice — against a fake /admin/business-hours.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  calls: [] as ApiCall[],
  week: null as unknown as BusinessHoursDto,
  holidays: [] as HolidayAdminDto[],
  failNext: null as ApiRequestError | null,
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path.startsWith('/admin/business-hours/holidays')) return { items: clone(api.holidays) };
      return clone(api.week);
    }),
    request: vi.fn(
      async (path: string, init: { method: string; json?: Record<string, unknown> }) => {
        api.calls.push({ method: init.method, path, body: init.json });
        if (api.failNext) {
          const error = api.failNext;
          api.failNext = null;
          throw error;
        }
        const updatedAt = nextStamp(api.calls.length);
        if (path === '/admin/business-hours') {
          const days = (init.json as { days: Array<Record<string, unknown>> }).days;
          api.week = {
            ...api.week,
            days: days.map(({ expectedUpdatedAt: _, ...d }) => ({
              ...(d as Omit<BusinessHoursDto['days'][number], 'updatedAt'>),
              updatedAt,
            })),
          };
          return clone(api.week);
        }
        const [, , , , id, action] = path.split('/');
        if (!id) {
          const body = init.json as { date: string; name: string; nameAr: string };
          const item: HolidayAdminDto = {
            id: `00000000-0000-4000-8000-${String(api.holidays.length + 10).padStart(12, '0')}`,
            date: body.date,
            name: body.name,
            nameAr: body.nameAr || null,
            isActive: true,
            createdAt: updatedAt,
            updatedAt,
          };
          api.holidays.push(item);
          return { item: clone(item) };
        }
        const index = api.holidays.findIndex((h) => h.id === id);
        const current = api.holidays[index]!;
        const next =
          action === 'archive' || action === 'restore'
            ? { ...current, isActive: action === 'restore', updatedAt }
            : {
                ...current,
                name: (init.json!.name as string) ?? current.name,
                nameAr: (init.json!.nameAr as string) || null,
                updatedAt,
              };
        api.holidays[index] = next;
        return { item: clone(next) };
      },
    ),
  },
}));

const STAMP = '2026-09-23T12:00:00.000Z';
function week(): BusinessHoursDto {
  return {
    days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      isOpen: weekday <= 4,
      open: '07:30',
      close: '16:30',
      updatedAt: `2026-09-23T12:00:0${weekday}.000Z`,
    })),
    timeZone: 'Asia/Qatar',
    businessDayMinutes: 540,
  };
}
function holiday(id: number, date: string, name: string, isActive = true): HolidayAdminDto {
  return {
    id: `00000000-0000-4000-8000-00000000000${id}`,
    date,
    name,
    nameAr: 'عطلة',
    isActive,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const year = new Date().getFullYear();
// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.week = week();
  api.holidays = [
    holiday(1, `${year}-12-18`, 'National Day'),
    holiday(2, `${year}-02-10`, 'Sports Day', false),
    holiday(3, `${year + 1}-12-18`, 'National Day'),
  ];
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const weekForm = () => screen.findByRole('form', { name: 'Working week' });
const dayGroup = async (name: string) => within(await weekForm()).findByRole('group', { name });

describe('working week', () => {
  it('shows each day, the time zone and the business-day length', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const sunday = await dayGroup('Sunday');
    expect(within(sunday).getByRole('switch', { name: 'Open on Sunday' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    expect((within(sunday).getByLabelText('Sunday opens at') as HTMLInputElement).value).toBe(
      '07:30',
    );
    const friday = await dayGroup('Friday');
    expect(within(friday).getByText('Closed')).toBeTruthy();
    expect((within(friday).getByLabelText('Friday closes at') as HTMLInputElement).disabled).toBe(
      true,
    );
    const form = await weekForm();
    expect(within(form).getByText(/Times are in .*Asia\/Qatar/)).toBeTruthy();
    expect(
      within(form)
        .getByRole('link', { name: /General settings/ })
        .getAttribute('href'),
    ).toBe('/admin/settings');
    expect(
      within(form).getByText(/A business day is 9 hours long, so “2 business days”/),
    ).toBeTruthy();
  });

  it('saves the whole week with each day’s expectedUpdatedAt; closed days keep their times', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const saturday = await dayGroup('Saturday');
    fireEvent.click(within(saturday).getByRole('switch'));
    fireEvent.change(within(saturday).getByLabelText('Saturday opens at'), {
      target: { value: '08:00' },
    });
    fireEvent.change(within(saturday).getByLabelText('Saturday closes at'), {
      target: { value: '12:00' },
    });
    fireEvent.click(within(await weekForm()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = api.calls.find((c) => c.method === 'PUT')!.body as {
      days: Array<Record<string, unknown>>;
    };
    expect(body.days).toHaveLength(7);
    expect(body.days[6]).toEqual({
      weekday: 6,
      isOpen: true,
      open: '08:00',
      close: '12:00',
      expectedUpdatedAt: '2026-09-23T12:00:06.000Z',
    });
    expect(body.days[5]).toMatchObject({ isOpen: false, open: '07:30', close: '16:30' });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Working week saved'));
  });

  it('refuses closing before opening, and a week with no open day', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const monday = await dayGroup('Monday');
    fireEvent.change(within(monday).getByLabelText('Monday closes at'), {
      target: { value: '07:00' },
    });
    fireEvent.click(within(await weekForm()).getByRole('button', { name: 'Save' }));
    expect(
      await within(monday).findByText('Closing time must be after opening time.'),
    ).toBeTruthy();
    expect(within(monday).getByLabelText('Monday closes at').getAttribute('aria-invalid')).toBe(
      'true',
    );
    fireEvent.change(within(monday).getByLabelText('Monday closes at'), {
      target: { value: '16:30' },
    });
    for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']) {
      fireEvent.click(within(await dayGroup(day)).getByRole('switch'));
    }
    fireEvent.click(within(await weekForm()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Keep at least one day open.')).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('a stale 409 keeps the edits, says so and reloads on request', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const monday = await dayGroup('Monday');
    fireEvent.change(within(monday).getByLabelText('Monday opens at'), {
      target: { value: '08:00' },
    });
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'changed', undefined, { reason: 'stale' });
    api.week.days[2] = {
      ...api.week.days[2]!,
      close: '15:00',
      updatedAt: '2026-09-29T08:00:00.000Z',
    };
    fireEvent.click(within(await weekForm()).getByRole('button', { name: 'Save' }));
    const form = await weekForm();
    expect(await within(form).findByText('Someone else changed this — reload')).toBeTruthy();
    expect((within(monday).getByLabelText('Monday opens at') as HTMLInputElement).value).toBe(
      '08:00',
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Reload' }));
    const tuesday = await dayGroup('Tuesday');
    await waitFor(() =>
      expect((within(tuesday).getByLabelText('Tuesday closes at') as HTMLInputElement).value).toBe(
        '15:00',
      ),
    );
    expect(within(form).queryByText('Someone else changed this — reload')).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
    const days = (
      api.calls.filter((c) => c.method === 'PUT')[1]!.body as {
        days: Array<{ expectedUpdatedAt: string }>;
      }
    ).days;
    expect(days[2]!.expectedUpdatedAt).toBe('2026-09-29T08:00:00.000Z');
  });
});

describe('holidays', () => {
  const holidaysTable = () => screen.findByRole('table', { name: 'Holidays' });

  it('lists this year’s active holidays; archived ones on request; other years by filter', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const table = await holidaysTable();
    await waitFor(() => expect(within(table).getByText('National Day')).toBeTruthy());
    expect(within(table).queryByText('Sports Day')).toBeNull();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(await within(table).findByText('Sports Day')).toBeTruthy();
    await choose(screen.getByLabelText('Year'), String(year + 1));
    await waitFor(() => expect(within(table).queryByText('Sports Day')).toBeNull());
    expect(within(table).getAllByText('National Day')).toHaveLength(1);
  });

  it('adds a holiday with bilingual names', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add holiday' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add a holiday' });
    fireEvent.change(within(sheet).getByLabelText(/^Date/), { target: { value: `${year}-06-15` } });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Name English/ }), {
      target: { value: 'Founders Day' },
    });
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Name العربية/ }), {
      target: { value: 'يوم المؤسسين' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      path: '/admin/business-hours/holidays',
      body: { date: `${year}-06-15`, name: 'Founders Day', nameAr: 'يوم المؤسسين' },
    });
    expect(await within(await holidaysTable()).findByText('Founders Day')).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Founders Day added');
  });

  it('offers to restore an archived holiday instead of adding its date again', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    await within(await holidaysTable()).findByText('National Day');
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.change(within(sheet).getByLabelText(/^Date/), { target: { value: `${year}-02-10` } });
    expect(
      await within(sheet).findByText(/This date has an archived holiday, Sports Day/),
    ).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore it' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        path: '/admin/business-hours/holidays/00000000-0000-4000-8000-000000000002/restore',
        body: { expectedUpdatedAt: STAMP },
      }),
    );
    // The sheet continues on the restored holiday (to rename it if needed).
    expect(await screen.findByRole('dialog', { name: 'Sports Day' })).toBeTruthy();
    // An active holiday on the typed date: open it instead.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Add holiday' }));
    const again = await screen.findByRole('dialog', { name: 'Add a holiday' });
    fireEvent.change(within(again).getByLabelText(/^Date/), { target: { value: `${year}-12-18` } });
    fireEvent.click(await within(again).findByRole('button', { name: 'Open it' }));
    expect(await screen.findByRole('dialog', { name: 'National Day' })).toBeTruthy();
  });

  it('renames and archives a holiday (with a confirmation); the date is fixed', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />);
    const table = await holidaysTable();
    const rowButton = async (name: string) =>
      within(
        (await within(table).findByText(name)).closest('[role="row"]') as HTMLElement,
      ).getByRole('button');
    fireEvent.click(await rowButton('National Day'));
    const sheet = await screen.findByRole('dialog', { name: 'National Day' });
    expect((within(sheet).getByLabelText(/^Date/) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(within(sheet).getByRole('textbox', { name: /Name English/ }), {
      target: { value: 'Qatar National Day' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: '/admin/business-hours/holidays/00000000-0000-4000-8000-000000000001',
        body: { name: 'Qatar National Day', nameAr: 'عطلة', expectedUpdatedAt: STAMP },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(await rowButton('Qatar National Day'));
    const reopened = await screen.findByRole('dialog', { name: 'Qatar National Day' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/SLA clocks will count this day again/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST').at(-1)?.path).toBe(
        '/admin/business-hours/holidays/00000000-0000-4000-8000-000000000001/archive',
      ),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Qatar National Day archived'));
  });

  it('renders in Arabic, right to left', async () => {
    renderSla(<BusinessHoursSection role="SUPER_ADMIN" userId="u1" />, { locale: 'ar' });
    expect(await screen.findByRole('form', { name: 'أسبوع العمل' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'الأحد' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة عطلة' })).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'العطلات' });
    expect(await within(table).findByText('National Day')).toBeTruthy();
    expect(within(table).getByText('عطلة').getAttribute('dir')).toBe('rtl');
    expect(document.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});
