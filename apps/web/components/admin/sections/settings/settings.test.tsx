// @vitest-environment jsdom
import type { GeneralSettingsDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { FORM_CONFIG } from '@/lib/tickets/test-fixtures';
import {
  choose,
  clone,
  nextStamp,
  renderSla,
  stubBrowserApis,
  type ApiCall,
} from '../sla/sla-test-utils';
import SettingsSection from '.';

// General settings (E11): the five values in one form, client checks (E.164 phone, 1–60 days,
// HH:mm), only changed values sent with expectedUpdatedAt (E19), server issues on the fields, the
// stale 409 reload, the security category chosen among the form's categories — against a fake
// /admin/settings.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  calls: [] as ApiCall[],
  settings: null as unknown as GeneralSettingsDto,
  failNext: null as ApiRequestError | null,
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path === '/config/ticket-form') {
        const { FORM_CONFIG: config } = await import('@/lib/tickets/test-fixtures');
        return JSON.parse(JSON.stringify(config));
      }
      return clone(api.settings);
    }),
    request: vi.fn(
      async (path: string, init: { method: string; json?: Record<string, unknown> }) => {
        api.calls.push({ method: init.method, path, body: init.json });
        if (api.failNext) {
          const error = api.failNext;
          api.failNext = null;
          throw error;
        }
        const values = (init.json as { values: Record<string, unknown> }).values;
        api.settings = {
          values: { ...api.settings.values, ...values } as GeneralSettingsDto['values'],
          updatedAt: nextStamp(api.calls.length),
        };
        return clone(api.settings);
      },
    ),
  },
}));

const STAMP = '2026-09-23T12:00:00.000Z';
// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.settings = {
    values: {
      businessTimezone: 'Asia/Qatar',
      socPhone: '+974 4000 0000',
      autoCloseDays: 5,
      p4DigestTime: '07:30',
      securityCategoryKey: 'cyber',
    },
    updatedAt: STAMP,
  };
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const form = () => screen.findByRole('form', { name: 'General settings' });
const save = async () =>
  fireEvent.click(within(await form()).getByRole('button', { name: 'Save' }));

describe('general settings section', () => {
  it('shows the five settings', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />);
    const f = await form();
    expect(within(f).getByRole('combobox', { name: /Business time zone/ }).textContent).toContain(
      'Asia/Qatar',
    );
    expect((within(f).getByLabelText(/SOC phone/) as HTMLInputElement).value).toBe(
      '+974 4000 0000',
    );
    expect((within(f).getByLabelText(/Close solved tickets after/) as HTMLInputElement).value).toBe(
      '5',
    );
    expect((within(f).getByLabelText(/Daily P4 digest time/) as HTMLInputElement).value).toBe(
      '07:30',
    );
    await waitFor(() =>
      expect(
        within(f).getByRole('combobox', { name: /Security incident category/ }).textContent,
      ).toContain(FORM_CONFIG.categories[0]!.labelEn),
    );
    expect(within(f).getByText(/reschedules the daily jobs within a minute/)).toBeTruthy();
    expect(screen.getByText(/Only Super Admins can open this section/)).toBeTruthy();
  });

  it('checks the phone, the days and the time before saving', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />);
    const f = await form();
    fireEvent.change(within(f).getByLabelText(/SOC phone/), { target: { value: '4000 0000' } });
    fireEvent.change(within(f).getByLabelText(/Close solved tickets after/), {
      target: { value: '61' },
    });
    fireEvent.change(within(f).getByLabelText(/Daily P4 digest time/), { target: { value: '' } });
    await save();
    expect(await within(f).findByText(/Enter an international number/)).toBeTruthy();
    expect(within(f).getByText('Use a whole number of days from 1 to 60.')).toBeTruthy();
    expect(within(f).getByText('Use a time like 07:30.')).toBeTruthy();
    expect(
      within(f)
        .getByLabelText(/SOC phone/)
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('sends only the changed values with expectedUpdatedAt', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />);
    const f = await form();
    fireEvent.change(within(f).getByLabelText(/Close solved tickets after/), {
      target: { value: '7' },
    });
    fireEvent.change(within(f).getByLabelText(/SOC phone/), { target: { value: '' } });
    await choose(within(f).getByRole('combobox', { name: /Business time zone/ }), 'Europe/London');
    await save();
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: '/admin/settings',
        body: {
          expectedUpdatedAt: STAMP,
          values: { autoCloseDays: 7, socPhone: null, businessTimezone: 'Europe/London' },
        },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
  }, 20_000); // jsdom renders the ~420 time-zone options of the select slowly

  it('puts server issues on their fields', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />);
    const f = await form();
    api.failNext = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      {
        location: 'body',
        path: ['values', 'securityCategoryKey'],
        message: 'validation.securityCategory',
        code: 'security_category',
      },
    ]);
    await choose(within(f).getByRole('combobox', { name: /Security incident category/ }), 'CCTV');
    await save();
    expect(
      await within(f).findByText('Choose an active category that has an active sub-type.'),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a stale 409 keeps the edits and reloads on request', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />);
    const f = await form();
    fireEvent.change(within(f).getByLabelText(/Close solved tickets after/), {
      target: { value: '9' },
    });
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'changed', undefined, { reason: 'stale' });
    api.settings = {
      values: { ...api.settings.values, p4DigestTime: '08:00' },
      updatedAt: '2026-09-29T07:00:00.000Z',
    };
    await save();
    expect(await within(f).findByText('Someone else changed this — reload')).toBeTruthy();
    expect((within(f).getByLabelText(/Close solved tickets after/) as HTMLInputElement).value).toBe(
      '9',
    );
    fireEvent.click(within(f).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect((within(f).getByLabelText(/Daily P4 digest time/) as HTMLInputElement).value).toBe(
        '08:00',
      ),
    );
    fireEvent.change(within(f).getByLabelText(/Close solved tickets after/), {
      target: { value: '9' },
    });
    await save();
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({
        expectedUpdatedAt: '2026-09-29T07:00:00.000Z',
        values: { autoCloseDays: 9 },
      }),
    );
  });

  it('renders in Arabic, right to left', async () => {
    renderSla(<SettingsSection role="SUPER_ADMIN" userId="u1" />, { locale: 'ar' });
    const f = await screen.findByRole('form', { name: 'الإعدادات العامة' });
    expect(
      within(f)
        .getByLabelText(/هاتف مركز العمليات الأمنية/)
        .getAttribute('dir'),
    ).toBe('ltr');
    expect(within(f).getByRole('button', { name: 'حفظ' })).toBeTruthy();
    expect(document.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});
