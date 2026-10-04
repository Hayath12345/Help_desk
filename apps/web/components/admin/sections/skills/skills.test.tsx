// @vitest-environment jsdom
import type { SkillAdminDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import SkillsSection from './index';
import { skillPatch } from './skill-sheet';
import {
  conflict,
  createFakeApi,
  invalid,
  renderSection,
  settle,
  stubBrowserApis,
  type,
  type FakeApi,
} from '../teams/people-test-utils';

const api = vi.hoisted(() => ({ current: null as FakeApi | null }));
vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: (url: string) => api.current!.client.get(url),
    request: (url: string, init: { method: string; json?: unknown }) =>
      api.current!.client.request(url, init),
  },
  getApiToken: vi.fn(async () => 'token'),
  clearApiToken: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const STAMP = '2026-09-29T10:00:00.000Z';
const NEWER = '2026-09-30T08:30:00.000Z';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function skill(n: number, labelEn: string, overrides: Partial<SkillAdminDto> = {}): SkillAdminDto {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    key: labelEn.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    labelEn,
    labelAr: '',
    isActive: true,
    staffCount: 0,
    categoryCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

let skills: SkillAdminDto[];
let network: SkillAdminDto;
let cctv: SkillAdminDto;
let fireAlarm: SkillAdminDto;
let biometrics: SkillAdminDto;

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  network = skill(1, 'Network', { labelAr: 'الشبكات', staffCount: 4, categoryCount: 2 });
  cctv = skill(2, 'CCTV', { staffCount: 2, categoryCount: 1 });
  fireAlarm = skill(3, 'Fire alarm', {
    labelAr: 'إنذار الحريق',
    isActive: false,
    staffCount: 1,
    updatedAt: '2026-09-20T09:00:00.000Z',
  });
  biometrics = skill(4, 'Biometrics');
  skills = [biometrics, cctv, fireAlarm, network];
  api.current = createFakeApi();
  api.current.on('GET /admin/skills', () => ({ items: skills }));
});
afterEach(cleanup);

const table = () => screen.getByRole('table', { name: 'Skills' });
const sheet = () => screen.getByRole('dialog');
const writes = () => api.current!.writes();

async function openSkill(name: RegExp) {
  fireEvent.click(await within(table()).findByRole('button', { name }));
  return screen.findByRole('dialog');
}

/**
 * The cell texts of a table row, found through its name button (a cell's last element is its
 * content: the column name before it is a phone-only label).
 */
function cellsOf(name: RegExp): string[] {
  const row = within(table()).getByRole('button', { name }).closest('[role="row"]');
  return within(row as HTMLElement)
    .getAllByRole('cell')
    .map((cell) => (cell.lastElementChild ?? cell).textContent ?? '');
}

describe('Skills section — list', () => {
  it('lists skills by English label with the Arabic name and the staff and category counts', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Skill', 'Arabic name', 'Staff', 'Categories']);
    // Active skills only until the switch is on; each row: name + key, Arabic name, counts.
    expect(
      within(table())
        .getAllByRole('button', { name: /./ })
        .map((b) => b.textContent),
    ).toEqual(['Biometricsbiometrics', 'CCTVcctv', 'Networknetwork']);
    expect(cellsOf(/^Network/)).toEqual(['Networknetwork', 'الشبكات', '4', '2']);
    expect(cellsOf(/^CCTV/)).toEqual(['CCTVcctv', 'No Arabic name', '2', '1']);
    expect(cellsOf(/^Biometrics/)).toEqual(['Biometricsbiometrics', 'No Arabic name', '0', '0']);
    // The Arabic name keeps its own direction inside the (left-to-right) page.
    const arabic = within(table()).getByText('الشبكات');
    expect(arabic.getAttribute('lang')).toBe('ar');
    expect(arabic.getAttribute('dir')).toBe('rtl');
    // The list asks for every skill; the switch only hides the archived ones.
    expect(api.current!.calls.find((c) => c.path === '/admin/skills')?.query.get('status')).toBe(
      'all',
    );
  });

  it('hides archived skills until "Show archived" is on', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    expect(within(table()).queryByRole('button', { name: /^Fire alarm/ })).toBeNull();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const archivedRow = await within(table()).findByRole('button', { name: /^Fire alarm/ });
    expect(archivedRow.closest('[role="row"]')?.hasAttribute('data-archived')).toBe(true);
    expect(
      within(archivedRow.closest('[role="row"]') as HTMLElement).getByText('Archived'),
    ).toBeTruthy();
  });

  it('explains skills, links to where they are used, and says who can see the section', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Skills decide who a new ticket goes to.');
    expect(note.textContent).toContain('does nothing');
    expect(
      within(note).getByRole('link', { name: 'Categories & sub-types' }).getAttribute('href'),
    ).toBe('/admin/categories');
    expect(within(note).getByRole('link', { name: 'Staff' }).getAttribute('href')).toBe(
      '/admin/staff',
    );
    expect(
      screen.getByText('Only Super Admins can open this section and change skills.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New skill' })).toBeTruthy();
  });

  it('shows an empty state with the first step', async () => {
    skills = [];
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    expect(await screen.findByText('No skills yet')).toBeTruthy();
    expect(screen.getByText(/Add the skills your team has/)).toBeTruthy();
  });

  it('shows a load error with Try again', async () => {
    let fail = true;
    api.current!.on('GET /admin/skills', () => {
      if (fail) throw new ApiRequestError(403, 'FORBIDDEN', 'no');
      return { items: skills };
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    expect(await screen.findByText('This list couldn’t be loaded.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await within(table()).findByRole('button', { name: /^Network/ })).toBeTruthy();
  });

  it('speaks Arabic in the Arabic UI', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />, 'ar');
    const grid = await screen.findByRole('table', { name: 'المهارات' });
    expect(await within(grid).findByRole('button', { name: /^Network/ })).toBeTruthy();
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['المهارة', 'الاسم بالعربية', 'الموظفون', 'الفئات']);
    expect(screen.getByRole('button', { name: 'مهارة جديدة' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'الفئات والأنواع الفرعية' }).getAttribute('href')).toBe(
      '/admin/categories',
    );
    expect(screen.getByRole('link', { name: 'الموظفون' }).getAttribute('href')).toBe(
      '/admin/staff',
    );
    expect(screen.getByText(/لا يفتح هذا القسم/)).toBeTruthy();
  });
});

describe('Skills section — create', () => {
  it('creates a skill: the key follows the English name and the API generates it', async () => {
    api.current!.on('POST /admin/skills', ({ body }) => {
      const input = body as { labelEn: string; labelAr: string };
      const row = skill(9, input.labelEn, { labelAr: input.labelAr });
      skills = [...skills, row];
      return { item: row };
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    expect(within(dialog).getByRole('heading', { name: 'New skill' })).toBeTruthy();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Wi-Fi');
    // The Arabic name is optional and sits in its own direction.
    const arabic = within(dialog).getByRole('textbox', { name: 'Skill name العربية' });
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(within(dialog).getByRole('textbox', { name: 'Key' })).toHaveProperty('value', 'wi-fi');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    // The suggested key is not sent: the API makes the key (and its collision suffix) itself.
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: '/admin/skills',
      body: { labelEn: 'Wi-Fi', labelAr: '' },
    });
    expect('key' in (writes()[0]!.body as object)).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Wi-Fi created');
    // The list refreshed with the new skill.
    expect(await within(table()).findByRole('button', { name: /^Wi-Fi/ })).toBeTruthy();
  });

  it('sends a key the admin typed, with the Arabic name', async () => {
    api.current!.on('POST /admin/skills', ({ body }) => ({
      item: skill(9, (body as { labelEn: string }).labelEn, { key: 'access-control' }),
    }));
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Door access');
    type(within(dialog).getByRole('textbox', { name: 'Skill name العربية' }), 'التحكم بالدخول');
    type(within(dialog).getByRole('textbox', { name: 'Key' }), 'access-control');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({
      key: 'access-control',
      labelEn: 'Door access',
      labelAr: 'التحكم بالدخول',
    });
  });

  it('asks for the English name before sending anything', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), '   ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('This field is required.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('puts a server validation issue on the field', async () => {
    api.current!.on('POST /admin/skills', () => {
      throw invalid([{ path: ['labelEn'], message: 'validation.tooLong' }]);
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    type(within(sheet()).getByRole('textbox', { name: 'Skill name English' }), 'Wi-Fi');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    const field = within(sheet()).getByRole('textbox', { name: 'Skill name English' });
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    expect(within(sheet()).getByText('This is too long.')).toBeTruthy();
  });

  it('a duplicate English name is shown on the field', async () => {
    api.current!.on('POST /admin/skills', () => {
      throw conflict({
        reason: 'duplicate',
        fields: ['labelEn'],
        existingId: cctv.id,
        existingIsActive: true,
      });
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'cctv');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(
        'A skill with this English name already exists. Choose another name.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole('textbox', { name: 'Skill name English' })
        .getAttribute('aria-invalid'),
    ).toBe('true');
    // An active duplicate has nothing to restore.
    expect(within(dialog).queryByRole('button', { name: /^Restore/ })).toBeNull();
    // Editing the name clears the error, and the dialog stays open.
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'cctv 2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
  });

  it('a duplicate that is archived offers to restore it instead', async () => {
    api.current!.on('POST /admin/skills', () => {
      throw conflict({
        reason: 'duplicate',
        fields: ['labelEn'],
        existingId: fireAlarm.id,
        existingIsActive: false,
      });
    });
    api.current!.on(`POST /admin/skills/${fireAlarm.id}/restore`, () => {
      fireAlarm = { ...fireAlarm, isActive: true, updatedAt: NEWER };
      skills = skills.map((s) => (s.id === fireAlarm.id ? fireAlarm : s));
      return { item: fireAlarm };
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Fire Alarm');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(
        /already exists, but it is archived\. Restore that skill instead/,
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: /^Restore .*Fire alarm.* instead$/ }),
    );
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({
      method: 'POST',
      path: `/admin/skills/${fireAlarm.id}/restore`,
      body: { expectedUpdatedAt: '2026-09-20T09:00:00.000Z' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Fire alarm restored');
    // It is an active skill again, in the list.
    expect(await within(table()).findByRole('button', { name: /^Fire alarm/ })).toBeTruthy();
  });

  it('a duplicate key lands on the key field', async () => {
    api.current!.on('POST /admin/skills', () => {
      throw conflict({
        reason: 'duplicate',
        fields: ['key'],
        existingId: network.id,
        existingIsActive: true,
      });
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Wi-Fi');
    type(within(dialog).getByRole('textbox', { name: 'Key' }), 'network');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(
        'This key is already used by another skill. Choose another one.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Key' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });
});

describe('Skills section — edit, archive and restore', () => {
  it('shows the key read-only and saves only the changed labels with expectedUpdatedAt', async () => {
    api.current!.on(`PATCH /admin/skills/${network.id}`, ({ body }) => ({
      item: { ...network, ...(body as object), updatedAt: NEWER },
    }));
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    const dialog = await openSkill(/^Network/);
    expect(within(dialog).getByRole('heading', { name: /^Edit .*Network/ })).toBeTruthy();
    const key = within(dialog).getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    expect(key.value).toBe('network');
    expect(key.readOnly).toBe(true);
    expect(within(dialog).getByText('The key can’t change after creation.')).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Skill name English' })).toHaveProperty(
      'value',
      'Network',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Skill name العربية' })).toHaveProperty(
      'value',
      'الشبكات',
    );
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Networking');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'PATCH',
      path: `/admin/skills/${network.id}`,
      body: { labelEn: 'Networking', expectedUpdatedAt: STAMP },
    });
    expect(writes()[0]!.body).not.toHaveProperty('labelAr');
    expect(writes()[0]!.body).not.toHaveProperty('key');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Changes saved');
  });

  it('closes without sending anything when nothing changed', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    const dialog = await openSkill(/^CCTV/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a stale save shows the reload state; Reload brings in the newer version', async () => {
    api.current!.on(`PATCH /admin/skills/${network.id}`, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    const dialog = await openSkill(/^Network/);
    type(within(dialog).getByRole('textbox', { name: 'Skill name English' }), 'Networking');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    // Someone else renamed it meanwhile.
    skills = skills.map((s) =>
      s.id === network.id ? { ...s, labelEn: 'Network & cabling', updatedAt: NEWER } : s,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(dialog).queryByText('Someone else changed this — reload')).toBeNull(),
    );
    expect(within(dialog).getByRole('textbox', { name: 'Skill name English' })).toHaveProperty(
      'value',
      'Network & cabling',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('archives after a confirmation that says how many staff and categories use the skill', async () => {
    api.current!.on(`POST /admin/skills/${network.id}/archive`, () => {
      network = { ...network, isActive: false, updatedAt: NEWER };
      skills = skills.map((s) => (s.id === network.id ? network : s));
      return { item: network };
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    const dialog = await openSkill(/^Network/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText(/4 active staff have this skill, and 2 active categories need it/),
    ).toBeTruthy();
    expect(within(confirm).getByText(/stops counting for automatic assignment/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: `/admin/skills/${network.id}/archive`,
      body: { expectedUpdatedAt: STAMP },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Network archived');
    // It drops out of the active list.
    await waitFor(() =>
      expect(within(table()).queryByRole('button', { name: /^Network/ })).toBeNull(),
    );
  });

  it('restores an archived skill from its sheet', async () => {
    api.current!.on(`POST /admin/skills/${fireAlarm.id}/restore`, () => {
      fireAlarm = { ...fireAlarm, isActive: true, updatedAt: NEWER };
      skills = skills.map((s) => (s.id === fireAlarm.id ? fireAlarm : s));
      return { item: fireAlarm };
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    await within(table()).findByRole('button', { name: /^Network/ });
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const dialog = await openSkill(/^Fire alarm/);
    expect(within(dialog).getByText(/This item is archived/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: 'POST',
      path: `/admin/skills/${fireAlarm.id}/restore`,
      body: { expectedUpdatedAt: '2026-09-20T09:00:00.000Z' },
    });
    expect(toast.success).toHaveBeenCalledWith('Fire alarm restored');
    // The sheet stays open on the restored skill, now with Archive instead of Restore.
    expect(await within(dialog).findByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(within(dialog).queryByText(/This item is archived/)).toBeNull();
  });

  it('shows a stale archive in the sheet instead of a toast', async () => {
    api.current!.on(`POST /admin/skills/${cctv.id}/archive`, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />);
    const dialog = await openSkill(/^CCTV/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    await settle();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the sheet in Arabic with the Arabic strings', async () => {
    renderSection(<SkillsSection role="SUPER_ADMIN" userId={ADMIN} />, 'ar');
    fireEvent.click(await screen.findByRole('button', { name: 'مهارة جديدة' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'مهارة جديدة' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'اسم المهارة English' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'إنشاء' })).toBeTruthy();
  });
});

describe('skillPatch', () => {
  it('sends only the labels that changed (never the key)', () => {
    const base = skill(1, 'Network', { labelAr: 'الشبكات' });
    expect(skillPatch(base, { labelEn: 'Network', labelAr: 'الشبكات', key: 'network' })).toBeNull();
    expect(skillPatch(base, { labelEn: 'Networking', labelAr: 'الشبكات', key: 'x' })).toEqual({
      labelEn: 'Networking',
    });
    expect(skillPatch(base, { labelEn: 'Network', labelAr: '', key: 'network' })).toEqual({
      labelAr: '',
    });
  });
});
