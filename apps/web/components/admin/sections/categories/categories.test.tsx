// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, TEAMS } from '@/lib/tickets/test-fixtures';
import { CategoryPreview } from './category-preview';
import CategoriesSection from './index';
import {
  FakeApi,
  apiError,
  categoryRow,
  choose,
  fieldRow,
  renderSetup,
  skillRow,
  stale,
  stubBrowserApis,
  type,
} from './setup-test-utils';

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

const FIELD_A = fieldRow(1, { labelEn: 'Camera ID', required: true });
const FIELD_B = fieldRow(2, {
  labelEn: 'Door side',
  type: 'DROPDOWN',
  options: [
    { value: 'left', labelEn: 'Left', labelAr: 'يسار', isActive: true },
    { value: 'old', labelEn: 'Old', labelAr: 'قديم', isActive: false },
  ],
});
const ARCHIVED_FIELD = fieldRow(3, { labelEn: 'Legacy field', isActive: false });

const SKILL_NET = skillRow(1, { labelEn: 'Network', labelAr: 'الشبكات' });
const SKILL_CCTV = skillRow(2, { labelEn: 'CCTV', labelAr: 'كاميرات المراقبة' });
const SKILL_OLD = skillRow(3, { labelEn: 'Legacy PBX', labelAr: 'مقسم قديم', isActive: false });
/** A skill as a category row carries it. */
const ref = ({ id, key, labelEn, labelAr, isActive }: ReturnType<typeof skillRow>) => ({
  id,
  key,
  labelEn,
  labelAr,
  isActive,
});

function withList(rows = [categoryRow(1), categoryRow(2)], catalog = [SKILL_CCTV, SKILL_NET]) {
  let items = rows;
  fake.api
    .on('GET', /^\/admin\/categories\?status=all$/, () => ({ items }))
    .on('GET', /^\/admin\/skills\?status=active$/, () => ({ items: catalog }))
    .on('GET', /^\/admin\/custom-fields\?status=all$/, {
      items: [FIELD_A, FIELD_B, ARCHIVED_FIELD],
    });
  return { set: (next: typeof rows) => void (items = next) };
}

const table = () => screen.getByRole('table', { name: 'Categories & sub-types' });
const sheet = () => screen.getByRole('dialog');

describe('Categories section', () => {
  it('lists categories with their team, sub-types and whether they are on the form', async () => {
    withList([
      categoryRow(1),
      categoryRow(2, { hiddenReason: 'no_active_subtype' }),
      categoryRow(3, { isActive: false, hiddenReason: 'archived' }),
    ]);
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    expect(await within(table()).findByRole('button', { name: /^Category 1/ })).toBeTruthy();
    expect(within(table()).getAllByText('ELV Field')).toHaveLength(2);
    expect(within(table()).getByText('Hidden: no active sub-type')).toBeTruthy();
    // Archived rows are hidden until "Show archived".
    expect(within(table()).queryByRole('button', { name: /^Category 3/ })).toBeNull();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(within(table()).getByRole('button', { name: /^Category 3/ })).toBeTruthy();
    expect(screen.getByText(/Only Super Admins can open this section/)).toBeTruthy();
  });

  it('creates a category with its first sub-type and linked fields; the preview follows the draft', async () => {
    const list = withList();
    fake.api.on('POST', /^\/admin\/categories$/, (body: unknown) => {
      const created = categoryRow(9, { labelEn: (body as { labelEn: string }).labelEn });
      list.set([categoryRow(1), categoryRow(2), created]);
      return { item: created };
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    await within(table()).findByRole('button', { name: /^Category 1/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const dialog = sheet();
    expect(within(dialog).getByRole('heading', { name: 'New category' })).toBeTruthy();

    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Door Access');
    type(within(dialog).getByRole('textbox', { name: 'Name العربية' }), 'الدخول');
    // The key follows the English name (E4).
    await waitFor(() =>
      expect((within(dialog).getByRole('textbox', { name: 'Key' }) as HTMLInputElement).value).toBe(
        'door-access',
      ),
    );
    await choose(within(dialog).getByRole('combobox', { name: /Routed to team/ }), 'SOC');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Lock' }));
    type(within(dialog).getByRole('textbox', { name: 'Sub-type name English' }), 'Card reader');
    await choose(within(dialog).getByRole('combobox', { name: 'Default priority' }), 'P2 High');
    // Archived fields are never offered.
    const add = within(dialog).getByRole('combobox', { name: 'Add a field…' });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(await screen.findByRole('option', { name: /^Door side/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Legacy field/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('option', { name: /^Door side/ }), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await choose(within(dialog).getByRole('combobox', { name: 'Add a field…' }), 'Camera ID');
    // Skills needed: the active catalog (never the archived one), explained, ticked like a list.
    const skills = within(dialog).getByRole('group', { name: 'Skills needed' });
    expect(within(dialog).getByText(/fewest open tickets/)).toBeTruthy();
    expect(within(dialog).getByText(/P1 tickets are never assigned automatically/)).toBeTruthy();
    fireEvent.click(await within(skills).findByRole('checkbox', { name: 'Network' }));
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'CCTV' }));
    expect(within(skills).getAllByRole('checkbox')).toHaveLength(2);

    // E16: the preview shows the draft — name, sub-type, default priority, fields in order.
    const preview = within(dialog).getByRole('region', { name: 'New ticket preview' });
    expect(within(preview).getByText('Door Access')).toBeTruthy();
    expect(within(preview).getByRole('combobox', { name: 'Sub-type' }).textContent).toBe(
      'Card reader',
    );
    const current = within(preview).getByRole('listitem', { current: true });
    expect(current.textContent).toContain('P2 High');
    expect(current.textContent).toContain('Default');
    expect(within(preview).getByText('Door side')).toBeTruthy();
    expect(within(preview).getByRole('textbox', { name: /Camera ID/ })).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.api.sent('POST', /^\/admin\/categories$/)).toHaveLength(1));
    expect(fake.api.sent('POST', /^\/admin\/categories$/)[0]).toEqual({
      key: 'door-access',
      labelEn: 'Door Access',
      labelAr: 'الدخول',
      icon: 'lock',
      assetPlaceholder: '',
      assetPlaceholderAr: '',
      teamId: TEAMS.soc.id,
      firstSubtype: { labelEn: 'Card reader', labelAr: '', defaultPriority: 'P2' },
      fieldIds: [FIELD_B.id, FIELD_A.id],
      skillIds: [SKILL_NET.id, SKILL_CCTV.id].sort(),
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Door Access created'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses to create without a name, a team or a first sub-type (no request)', async () => {
    withList();
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    await within(table()).findByRole('button', { name: /^Category 1/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    expect(await within(sheet()).findAllByText('This field is required.')).toHaveLength(3);
    expect(fake.api.sent('POST', /^\/admin\/categories$/)).toEqual([]);
  });

  it('edits a category (changed fields + expectedUpdatedAt), then the linked fields', async () => {
    const row = categoryRow(1, {
      fields: [
        {
          fieldId: FIELD_A.id,
          key: FIELD_A.key,
          labelEn: FIELD_A.labelEn,
          labelAr: FIELD_A.labelAr,
          type: 'TEXT',
          required: true,
          isActive: true,
          sortOrder: 0,
        },
      ],
    });
    withList([row]);
    const patched = { ...row, labelEn: 'Renamed', updatedAt: '2026-09-29T11:00:00.000Z' };
    fake.api
      .on('PATCH', /^\/admin\/categories\/[^/]+$/, { item: patched })
      .on('PUT', /\/fields$/, { item: { ...patched, updatedAt: '2026-09-29T11:00:01.000Z' } });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const dialog = sheet();
    // The key is read-only after creation.
    expect(
      within(dialog).getByRole('textbox', { name: 'Key' }).getAttribute('readonly'),
    ).not.toBeNull();
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Renamed');
    await within(dialog).findByRole('button', { name: 'Remove Camera ID' }); // catalog loaded
    await choose(within(dialog).getByRole('combobox', { name: 'Add a field…' }), 'Door side');
    // Move the new field above the first one (keyboard reorder, E3).
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Door side up' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.api.sent('PUT', /\/fields$/)).toHaveLength(1));
    expect(fake.api.sent('PATCH', /^\/admin\/categories\//)).toEqual([
      { labelEn: 'Renamed', expectedUpdatedAt: row.updatedAt },
    ]);
    // The fields request starts from the category's new updatedAt.
    expect(fake.api.sent('PUT', /\/fields$/)).toEqual([
      { expectedUpdatedAt: patched.updatedAt, fieldIds: [FIELD_B.id, FIELD_A.id] },
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'));
  });

  it('saves the skills after the category and its fields, each from the version the last write returned', async () => {
    const row = categoryRow(1, { skills: [ref(SKILL_NET), ref(SKILL_OLD)] });
    withList([row]);
    const T1 = '2026-09-29T11:00:00.000Z';
    const T2 = '2026-09-29T11:00:01.000Z';
    const T3 = '2026-09-29T11:00:02.000Z';
    const patched = { ...row, labelEn: 'Renamed', updatedAt: T1 };
    fake.api
      .on('PATCH', /^\/admin\/categories\/[^/]+$/, { item: patched })
      .on('PUT', /\/fields$/, { item: { ...patched, updatedAt: T2 } })
      .on('PUT', /\/skills$/, { item: { ...patched, updatedAt: T3 } });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Renamed');
    const add = within(dialog).getByRole('combobox', { name: 'Add a field…' });
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false)); // catalog loaded
    await choose(add, 'Door side');

    // The archived skill the category still needs stays listed, ticked and flagged; it can go.
    const skills = within(dialog).getByRole('group', { name: 'Skills needed' });
    const legacy = await within(skills).findByRole('checkbox', { name: /Legacy PBX/ });
    expect(legacy.getAttribute('aria-checked')).toBe('true');
    expect(within(skills).getByText('Archived')).toBeTruthy();
    fireEvent.click(legacy);
    fireEvent.click(within(skills).getByRole('checkbox', { name: 'CCTV' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fake.api.sent('PUT', /\/skills$/)).toHaveLength(1));
    expect(fake.api.sent('PATCH', /^\/admin\/categories\//)).toEqual([
      { labelEn: 'Renamed', expectedUpdatedAt: row.updatedAt },
    ]);
    expect(fake.api.sent('PUT', /\/fields$/)).toEqual([
      { expectedUpdatedAt: T1, fieldIds: [FIELD_B.id] },
    ]);
    expect(fake.api.sent('PUT', /\/skills$/)).toEqual([
      { expectedUpdatedAt: T2, skillIds: [SKILL_NET.id, SKILL_CCTV.id].sort() },
    ]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Changes saved'));
  });

  it('a skills-only edit sends just PUT /skills with the row’s own updatedAt', async () => {
    const row = categoryRow(1, { skills: [ref(SKILL_NET)] });
    withList([row]);
    fake.api.on('PUT', /\/skills$/, {
      item: { ...row, skills: [], updatedAt: '2026-09-29T11:00:00.000Z' },
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const skills = within(sheet()).getByRole('group', { name: 'Skills needed' });
    // Unticking the last skill clears the list: tickets stay in the team queue.
    fireEvent.click(await within(skills).findByRole('checkbox', { name: 'Network' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.api.sent('PUT', /\/skills$/)).toHaveLength(1));
    expect(fake.api.sent('PUT', /\/skills$/)).toEqual([
      { expectedUpdatedAt: row.updatedAt, skillIds: [] },
    ]);
    expect(fake.api.sent('PATCH', /^\/admin\/categories\//)).toEqual([]);
    expect(fake.api.sent('PUT', /\/fields$/)).toEqual([]);
  });

  it('saving without a change to the skills never calls PUT /skills', async () => {
    const row = categoryRow(1, { skills: [ref(SKILL_NET), ref(SKILL_CCTV)] });
    withList([row]);
    fake.api.on('PATCH', /^\/admin\/categories\/[^/]+$/, {
      item: { ...row, labelEn: 'Renamed', updatedAt: '2026-09-29T11:00:00.000Z' },
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const skills = within(sheet()).getByRole('group', { name: 'Skills needed' });
    // Unticking and ticking again is no change.
    const cctv = await within(skills).findByRole('checkbox', { name: 'CCTV' });
    fireEvent.click(cctv);
    fireEvent.click(cctv);
    type(within(sheet()).getByRole('textbox', { name: 'Name English' }), 'Renamed');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fake.api.sent('PATCH', /^\/admin\/categories\//)).toHaveLength(1));
    expect(fake.api.sent('PUT', /\/skills$/)).toEqual([]);
  });

  it('a stale skills save shows the reload state; an archived skill is refused on the list', async () => {
    const row = categoryRow(1);
    withList([row]);
    let answer: Error = stale();
    fake.api.on('PUT', /\/skills$/, () => {
      throw answer;
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const skills = within(sheet()).getByRole('group', { name: 'Skills needed' });
    fireEvent.click(await within(skills).findByRole('checkbox', { name: 'CCTV' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await within(sheet()).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();

    // After a reload the API may still refuse a skill that was archived meanwhile: it is said
    // on the list (400 validation.skillArchived), not as a toast.
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(sheet()).queryByText('Someone else changed this — reload')).toBeNull(),
    );
    answer = apiError(400, 'VALIDATION_FAILED', [
      { path: ['skillIds'], message: 'validation.skillArchived', location: 'body', code: 'custom' },
    ]);
    fireEvent.click(within(sheet()).getByRole('checkbox', { name: 'CCTV' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(
      await within(sheet()).findByText('This skill is archived — restore it first.'),
    ).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says how to add skills when the catalog is empty, and lists them as chips in the table', async () => {
    const extra = [skillRow(4, { labelEn: 'VPN' }), skillRow(5, { labelEn: 'Wi-Fi' })].map(ref);
    withList(
      [
        categoryRow(1, {
          skills: [ref(SKILL_NET), ref(SKILL_CCTV), ...extra, ref(SKILL_OLD)],
        }),
        categoryRow(2),
      ],
      [],
    );
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    const open = await within(table()).findByRole('button', { name: /^Category 1/ });
    // The first three active skills and "+N" for the rest; the archived one is left out.
    const row = within(open.closest('[role="row"]') as HTMLElement);
    expect(row.getByText('Network')).toBeTruthy();
    expect(row.getByText('CCTV')).toBeTruthy();
    expect(row.getByText('VPN')).toBeTruthy();
    expect(row.getByText('+1')).toBeTruthy();
    expect(row.queryByText('Legacy PBX')).toBeNull();

    fireEvent.click(within(table()).getByRole('button', { name: /^Category 2/ }));
    const skills = within(sheet()).getByRole('group', { name: 'Skills needed' });
    expect(await within(skills).findByText(/No skills yet/)).toBeTruthy();
    expect(within(skills).getByRole('link', { name: 'Skills' }).getAttribute('href')).toBe(
      '/admin/skills',
    );
    expect(within(skills).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shows "Someone else changed this — reload" on a stale save, and reloads the latest', async () => {
    const list = withList([categoryRow(1)]);
    fake.api.on('PATCH', /^\/admin\/categories\//, () => {
      throw stale();
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    type(within(sheet()).getByRole('textbox', { name: 'Name English' }), 'Mine');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await within(sheet()).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
    list.set([categoryRow(1, { labelEn: 'Theirs', updatedAt: '2026-09-29T12:00:00.000Z' })]);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        (within(sheet()).getByRole('textbox', { name: 'Name English' }) as HTMLInputElement).value,
      ).toBe('Theirs'),
    );
    expect(within(sheet()).queryByText('Someone else changed this — reload')).toBeNull();
  });

  it('archives (with a confirmation) and shows an archive guard from the API', async () => {
    withList([categoryRow(1), categoryRow(2)]);
    fake.api.on('POST', /categories\/[^/]+\/archive$/, () => {
      throw apiError(409, 'CONFLICT', { reason: 'guard', guard: 'category_team_archived' });
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 2/ }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/leaves the New ticket form right away/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    expect(
      await screen.findByText(/This category routes to an archived team/, { selector: 'div' }),
    ).toBeTruthy();
    expect(fake.api.sent('POST', /archive$/)).toEqual([
      { expectedUpdatedAt: categoryRow(2).updatedAt },
    ]);
  });

  it('the security category has no Archive button and says why', async () => {
    withList([categoryRow(1, { isSecurityCategory: true })]);
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    expect(within(sheet()).getByText(/This is the security category/)).toBeTruthy();
    expect(within(sheet()).queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('reorders categories by keyboard: one request with the expected order', async () => {
    withList([categoryRow(1), categoryRow(2)]);
    fake.api.on('POST', /^\/admin\/categories\/reorder$/, undefined);
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    await within(table()).findByRole('button', { name: /^Category 1/ });
    fireEvent.click(screen.getByRole('button', { name: 'Move Category 2 up' }));
    await waitFor(() => expect(fake.api.sent('POST', /reorder$/)).toHaveLength(1));
    expect(fake.api.sent('POST', /reorder$/)[0]).toEqual({
      ids: [categoryRow(2).id, categoryRow(1).id],
      expectedIds: [categoryRow(1).id, categoryRow(2).id],
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('New order saved'));
  });

  it('manages sub-types inside the sheet: add, archive, restore (saved at once)', async () => {
    const row = categoryRow(1);
    const archived = { ...row.subtypes[1]!, isActive: false };
    withList([{ ...row, subtypes: [row.subtypes[0]!, archived] }]);
    fake.api
      .on('POST', /subtypes$/, (body: unknown) => ({
        item: { ...row.subtypes[0]!, id: row.subtypes[0]!.id, ...(body as object) },
      }))
      .on('POST', /subtypes\/[^/]+\/restore$/, { item: { ...archived, isActive: true } });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const section = within(sheet()).getByRole('region', { name: 'Sub-types' });
    fireEvent.click(within(section).getByRole('button', { name: 'Add sub-type' }));
    const editor = within(section).getByRole('group', { name: 'New sub-type' });
    type(within(editor).getByRole('textbox', { name: 'Sub-type name English' }), 'Tailgating');
    fireEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(fake.api.sent('POST', /subtypes$/)).toEqual([
        { labelEn: 'Tailgating', labelAr: '', defaultPriority: 'P3' },
      ]),
    );
    fireEvent.click(within(section).getByRole('button', { name: `Restore ${archived.labelEn}` }));
    await waitFor(() =>
      expect(fake.api.sent('POST', /restore$/)).toEqual([
        { expectedUpdatedAt: archived.updatedAt },
      ]),
    );
  });

  it('a sub-type edit sends the version it started from and only what changed (E19)', async () => {
    const row = categoryRow(1);
    const kind = row.subtypes[0]!;
    const lists = withList([row]);
    fake.api.on('PATCH', /subtypes\/[^/]+$/, () => {
      throw stale();
    });
    const { queryClient } = renderSetup(
      <CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />,
    );
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const section = within(sheet()).getByRole('region', { name: 'Sub-types' });
    fireEvent.click(within(section).getByRole('button', { name: `Edit ${kind.labelEn}` }));
    const editor = within(section).getByRole('group', { name: 'Edit sub-type' });
    type(within(editor).getByRole('textbox', { name: 'Sub-type name English' }), 'Renamed by A');
    // Another admin sets the default priority to P1 meanwhile; the list refetches.
    const NEWER = '2026-09-29T11:00:00.000Z';
    lists.set([
      {
        ...row,
        subtypes: [{ ...kind, defaultPriority: 'P1', updatedAt: NEWER }, row.subtypes[1]!],
      },
    ]);
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(
        fake.api.calls.filter((c) => c.method === 'GET' && /categories/.test(c.path)),
      ).toHaveLength(2),
    );
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(fake.api.sent('PATCH', /subtypes\/[^/]+$/)).toEqual([
        { expectedUpdatedAt: kind.updatedAt, labelEn: 'Renamed by A' },
      ]),
    );
    expect(await within(editor).findByRole('alert')).toBeTruthy();
  });

  it('a sub-type edit with no change sends nothing, even after a concurrent change', async () => {
    const row = categoryRow(1);
    const kind = row.subtypes[0]!;
    const lists = withList([row]);
    const { queryClient } = renderSetup(
      <CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />,
    );
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const section = within(sheet()).getByRole('region', { name: 'Sub-types' });
    fireEvent.click(within(section).getByRole('button', { name: `Edit ${kind.labelEn}` }));
    const editor = within(section).getByRole('group', { name: 'Edit sub-type' });
    lists.set([
      {
        ...row,
        subtypes: [
          { ...kind, defaultPriority: 'P1', updatedAt: '2026-09-29T11:00:00.000Z' },
          row.subtypes[1]!,
        ],
      },
    ]);
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(
        fake.api.calls.filter((c) => c.method === 'GET' && /categories/.test(c.path)),
      ).toHaveLength(2),
    );
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(section).queryByRole('group', { name: 'Edit sub-type' })).toBeNull(),
    );
    expect(fake.api.sent('PATCH', /subtypes\/[^/]+$/)).toEqual([]);
  });

  it('sub-type editor: takes focus, Escape cancels only it, typed text makes closing ask', async () => {
    withList([categoryRow(1)]);
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const section = within(sheet()).getByRole('region', { name: 'Sub-types' });
    const add = within(section).getByRole('button', { name: 'Add sub-type' });
    fireEvent.click(add);
    const editor = within(section).getByRole('group', { name: 'New sub-type' });
    const name = within(editor).getByRole('textbox', { name: 'Sub-type name English' });
    await waitFor(() => expect(document.activeElement).toBe(name));

    // Escape inside the editor closes the editor, not the sheet; focus is back on Add.
    type(name, 'Lens fogged');
    fireEvent.keyDown(name, { key: 'Escape' });
    await waitFor(() => expect(within(section).queryByRole('group')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(section).getByRole('button', { name: 'Add sub-type' }),
      ),
    );

    // Typed text in an open editor: closing the sheet asks before discarding it.
    fireEvent.click(within(section).getByRole('button', { name: 'Add sub-type' }));
    type(within(section).getByRole('textbox', { name: 'Sub-type name English' }), 'Lens fogged');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard your changes?' })).toBeTruthy();
    expect(fake.api.sent('POST', /subtypes$/)).toEqual([]);
  });

  it('editing and archiving a sub-type keep keyboard focus in the list', async () => {
    const row = categoryRow(1);
    const extra = {
      ...row.subtypes[1]!,
      id: `${row.subtypes[1]!.id.slice(0, -1)}9`,
      labelEn: 'Third kind',
    };
    const lists = withList([{ ...row, subtypes: [...row.subtypes, extra] }]);
    fake.api.on('POST', /subtypes\/[^/]+\/archive$/, (_body: unknown, match: RegExpMatchArray) => {
      const archived = { ...row.subtypes[0]!, isActive: false };
      lists.set([{ ...row, subtypes: [archived, row.subtypes[1]!, extra] }]);
      void match;
      return { item: archived };
    });
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Category 1/ }));
    const section = within(sheet()).getByRole('region', { name: 'Sub-types' });
    const first = row.subtypes[0]!.labelEn;
    const second = row.subtypes[1]!.labelEn;

    // Edit → Cancel gives focus back to that sub-type's Edit button.
    fireEvent.click(within(section).getByRole('button', { name: `Edit ${second}` }));
    const editor = within(section).getByRole('group', { name: 'Edit sub-type' });
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(section).getByRole('button', { name: `Edit ${second}` }),
      ),
    );

    // Archive the first: focus moves to the next sub-type's Archive button.
    const archive = within(section).getByRole('button', { name: `Archive ${first}` });
    archive.focus();
    fireEvent.click(archive);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(section).getByRole('button', { name: `Archive ${second}` }),
      ),
    );
  });

  it('the preview marks every required field with a star, as the New Ticket form does', () => {
    const base = { placeholderEn: null, placeholderAr: null, labelAr: '' };
    const option = { value: 'x', labelEn: 'X', labelAr: '' };
    renderSetup(
      <CategoryPreview
        labelEn="Door access"
        labelAr=""
        icon="door"
        team={null}
        assetPlaceholder=""
        assetPlaceholderAr=""
        subtypes={[{ id: 's1', labelEn: 'Reader', labelAr: '', defaultPriority: 'P3' }]}
        slaPolicies={undefined}
        fields={[
          {
            ...base,
            id: 'f1',
            labelEn: 'Floors',
            type: 'MULTI_SELECT',
            required: true,
            options: [option],
          },
          { ...base, id: 'f2', labelEn: 'On site?', type: 'YES_NO', required: true, options: [] },
          {
            ...base,
            id: 'f3',
            labelEn: 'Door side',
            type: 'DROPDOWN',
            required: true,
            options: [option],
          },
          { ...base, id: 'f4', labelEn: 'Notes', type: 'TEXT', required: false, options: [] },
        ]}
      />,
    );
    const preview = screen.getByRole('region', { name: 'New ticket preview' });
    for (const name of ['Floors', 'On site?', 'Door side']) {
      const label = within(preview).getByText(name).parentElement!;
      expect(label.textContent, name).toContain(`${name} *`);
    }
    expect(within(preview).getByText('Notes').parentElement!.textContent).not.toContain('*');
  });

  it('the preview shows the form’s default asset hint when the category has no example (E16)', () => {
    const props = {
      labelEn: 'Door access',
      labelAr: '',
      icon: 'door',
      team: null,
      assetPlaceholderAr: '',
      subtypes: [],
      fields: [],
      slaPolicies: undefined,
    };
    const asset = () =>
      within(screen.getByRole('region', { name: 'New ticket preview' })).getByRole('textbox', {
        name: /Asset/,
      });
    renderSetup(<CategoryPreview {...props} assetPlaceholder="" />);
    expect(asset().getAttribute('placeholder')).toBe('e.g. CAM-014, RDR-203');
    cleanup();
    renderSetup(<CategoryPreview {...props} assetPlaceholder="e.g. FW-01" />);
    expect(asset().getAttribute('placeholder')).toBe('e.g. FW-01');
  });

  it('the preview’s default asset hint is the Arabic one in the Arabic UI', () => {
    renderSetup(
      <CategoryPreview
        labelEn="Door access"
        labelAr=""
        icon="door"
        team={null}
        assetPlaceholder=""
        assetPlaceholderAr=""
        subtypes={[]}
        fields={[]}
        slaPolicies={undefined}
      />,
      { locale: 'ar' },
    );
    const preview = screen.getByRole('region', { name: 'معاينة التذكرة الجديدة' });
    expect(within(preview).getAllByRole('textbox')[0]!.getAttribute('placeholder')).toBe(
      'مثال: CAM-014، RDR-203',
    );
  });

  it('speaks Arabic in the Arabic UI (labels, RTL inputs, preview)', async () => {
    withList([categoryRow(1)]);
    renderSetup(<CategoriesSection role="SUPER_ADMIN" userId={IDS.staff} />, { locale: 'ar' });
    const grid = await screen.findByRole('table', { name: 'الفئات والأنواع الفرعية' });
    expect(await within(grid).findByRole('button', { name: /^فئة 1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء جديد' }));
    const dialog = sheet();
    expect(within(dialog).getByRole('heading', { name: 'فئة جديدة' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'الاسم العربية' }).getAttribute('dir')).toBe(
      'rtl',
    );
    expect(within(dialog).getByRole('region', { name: 'معاينة التذكرة الجديدة' })).toBeTruthy();
    const skills = within(dialog).getByRole('group', { name: 'المهارات المطلوبة' });
    expect(await within(skills).findByRole('checkbox', { name: 'الشبكات' })).toBeTruthy();
    expect(within(dialog).getByText(/لا تُسند تذاكر P1 تلقائيًا أبدًا/)).toBeTruthy();
  });
});
