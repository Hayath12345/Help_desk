// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS } from '@/lib/tickets/test-fixtures';
import {
  FakeApi,
  apiError,
  categoryRow,
  choose,
  fieldRow,
  renderSetup,
  stale,
  stubBrowserApis,
  type,
} from '../categories/setup-test-utils';
import CustomFieldsSection from './index';

const fake = vi.hoisted(() => ({ api: null as unknown as FakeApi }));
vi.mock('@/lib/api/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/browser')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      get: (path: string) => fake.api.handle('GET', path),
      request: (path: string, init: { method?: string; json?: unknown } = {}) =>
        fake.api.handle(init.method ?? 'GET', path, init.json),
    },
  };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// Multi-step sheet flows: allow for a loaded machine (the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  fake.api = new FakeApi();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const CAT_1 = categoryRow(1);
const CAT_2 = categoryRow(2);
const DROPDOWN = fieldRow(1, {
  labelEn: 'Door side',
  type: 'DROPDOWN',
  options: [
    { value: 'left', labelEn: 'Left', labelAr: 'يسار', isActive: true },
    { value: 'right', labelEn: 'Right', labelAr: 'يمين', isActive: true },
  ],
  categories: [
    {
      id: CAT_1.id,
      key: CAT_1.key,
      labelEn: CAT_1.labelEn,
      labelAr: CAT_1.labelAr,
      isActive: true,
      sortOrder: 0,
    },
  ],
});

function withList(rows = [DROPDOWN, fieldRow(2)]) {
  fake.api
    .on('GET', /^\/admin\/custom-fields\?status=all$/, { items: rows })
    .on('GET', /^\/admin\/categories\?status=all$/, { items: [CAT_1, CAT_2] });
}

const table = () => screen.getByRole('table', { name: 'Custom fields' });
const sheet = () => screen.getByRole('dialog');

describe('Custom fields section', () => {
  it('lists fields with type, options, required and categories', async () => {
    withList([DROPDOWN, fieldRow(2, { required: true }), fieldRow(3, { isActive: false })]);
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />);
    const row = (await within(table()).findByRole('button', { name: /^Door side/ })).closest(
      '[role="row"]',
    ) as HTMLElement;
    expect(within(row).getByText('Dropdown')).toBeTruthy();
    expect(within(row).getByText('2 options')).toBeTruthy();
    expect(within(row).getByText('Category 1')).toBeTruthy();
    const second = within(table())
      .getByRole('button', { name: /^Field 2/ })
      .closest('[role="row"]') as HTMLElement;
    expect(within(second).getByText('Required', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
  });

  it('creates a dropdown with options (values from the English labels) linked to a category', async () => {
    withList();
    fake.api.on('POST', /^\/admin\/custom-fields$/, (body: unknown) => ({
      item: fieldRow(9, { labelEn: (body as { labelEn: string }).labelEn }),
    }));
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />);
    await within(table()).findByRole('button', { name: /^Door side/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Badge colour');
    await waitFor(() =>
      expect((within(dialog).getByRole('textbox', { name: 'Key' }) as HTMLInputElement).value).toBe(
        'badge_colour',
      ),
    );
    await choose(within(dialog).getByRole('combobox', { name: /^Type/ }), 'Dropdown');
    // Saving without options is refused before any request.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Add at least one active option.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add option' }));
    const option = () => within(dialog).getByRole('listitem', { name: 'Option 1' });
    const en = within(option()).getByRole('textbox', { name: 'Label English' });
    type(en, 'Dark Blue');
    fireEvent.blur(en);
    await waitFor(() =>
      expect(
        (within(option()).getByRole('textbox', { name: 'Value' }) as HTMLInputElement).value,
      ).toBe('dark_blue'),
    );
    type(within(option()).getByRole('textbox', { name: 'Label العربية' }), 'أزرق');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Required' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Category 2' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.api.sent('POST', /custom-fields$/)).toHaveLength(1));
    expect(fake.api.sent('POST', /custom-fields$/)[0]).toEqual({
      key: 'badge_colour',
      labelEn: 'Badge colour',
      labelAr: '',
      type: 'DROPDOWN',
      options: [{ value: 'dark_blue', labelEn: 'Dark Blue', labelAr: 'أزرق', isActive: true }],
      placeholderEn: '',
      placeholderAr: '',
      required: true,
      categoryIds: [CAT_2.id],
    });
  });

  it('archives an option instead of removing it and sends only what changed', async () => {
    withList();
    fake.api.on('PATCH', /custom-fields\/[^/]+$/, { item: DROPDOWN });
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Door side/ }));
    const dialog = sheet();
    // A saved option's value is fixed.
    const first = within(dialog).getByRole('listitem', { name: 'Option 1' });
    expect(
      within(first).getByRole('textbox', { name: 'Value' }).getAttribute('readonly'),
    ).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive option Right' }));
    expect(within(dialog).getByRole('button', { name: 'Restore option Right' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.api.sent('PATCH', /custom-fields/)).toHaveLength(1));
    expect(fake.api.sent('PATCH', /custom-fields/)[0]).toEqual({
      options: [
        { value: 'left', labelEn: 'Left', labelAr: 'يسار', isActive: true },
        { value: 'right', labelEn: 'Right', labelAr: 'يمين', isActive: false },
      ],
      expectedUpdatedAt: DROPDOWN.updatedAt,
    });
  });

  it('explains the API guards: an option in use can’t be removed, the type can’t change', async () => {
    withList();
    fake.api.on('PATCH', /custom-fields\/[^/]+$/, () => {
      throw apiError(409, 'CONFLICT', { reason: 'guard', guard: 'option_in_use' });
    });
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Door side/ }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove option Left' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet()).findByText(/Archive that option instead of removing it/),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();

    fake.api.on('PATCH', /custom-fields\/[^/]+$/, () => {
      throw apiError(409, 'CONFLICT', { reason: 'guard', guard: 'field_type_in_use' });
    });
    await choose(within(sheet()).getByRole('combobox', { name: /^Type/ }), 'Text');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await within(sheet()).findByText(/its type can’t change/)).toBeTruthy();
    expect(fake.api.sent('PATCH', /custom-fields/)[1]).toMatchObject({ type: 'TEXT' });
  });

  it('a stale save shows the reload state; a duplicate key goes on the key field', async () => {
    withList();
    fake.api
      .on('PATCH', /custom-fields\/[^/]+$/, () => {
        throw stale();
      })
      .on('POST', /custom-fields$/, () => {
        throw apiError(409, 'CONFLICT', {
          reason: 'duplicate',
          fields: ['key'],
          existingId: DROPDOWN.id,
          existingIsActive: false,
        });
      });
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Field 2/ }));
    type(within(sheet()).getByRole('textbox', { name: 'Name English' }), 'Changed');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await within(sheet()).findByText('Someone else changed this — reload')).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    type(within(sheet()).getByRole('textbox', { name: 'Name English' }), 'Door side');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    expect(await within(sheet()).findByText(/This key belongs to an archived item/)).toBeTruthy();
  });

  it('speaks Arabic (types, headers) in the Arabic UI', async () => {
    withList();
    renderSetup(<CustomFieldsSection role="SUPER_ADMIN" userId={IDS.staff} />, { locale: 'ar' });
    const grid = await screen.findByRole('table', { name: 'الحقول المخصصة' });
    expect(await within(grid).findByText('قائمة منسدلة')).toBeTruthy();
    expect(within(grid).getByText('خياران')).toBeTruthy();
  });
});
