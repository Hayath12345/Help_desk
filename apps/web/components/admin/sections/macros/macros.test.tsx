// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, TEAMS } from '@/lib/tickets/test-fixtures';
import {
  FakeApi,
  apiError,
  choose,
  macroRow,
  renderSetup,
  stale,
  stubBrowserApis,
  type,
} from '../categories/setup-test-utils';
import MacrosSection from './index';

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

const socTeam = { ...TEAMS.soc, isActive: true };
const GLOBAL_1 = macroRow(1, { titleEn: 'Thanks' });
const GLOBAL_2 = macroRow(2, { titleEn: 'Closing', setStatus: 'SOLVED' });
const SOC_1 = macroRow(3, { titleEn: 'SOC hello', teamId: socTeam.id, team: socTeam });

function withList(items = [GLOBAL_1, GLOBAL_2, SOC_1]) {
  fake.api.on('GET', /^\/admin\/macros\?(.*)$/, (_body: unknown, match: RegExpMatchArray) => {
    const params = new URLSearchParams(match[1]);
    const teamId = params.get('teamId');
    return {
      items: items.filter((m) =>
        teamId === null ? true : teamId === 'global' ? m.teamId === null : m.teamId === teamId,
      ),
    };
  });
}

const table = () => screen.getByRole('table', { name: 'Macros' });
const sheet = () => screen.getByRole('dialog');

describe('Macros section — super admin', () => {
  it('lists global and team macros; reorder only within one scope', async () => {
    withList();
    fake.api.on('POST', /^\/admin\/macros\/reorder$/, undefined);
    renderSetup(<MacrosSection role="SUPER_ADMIN" userId={IDS.staff} />);
    expect(await within(table()).findByRole('button', { name: /^Thanks/ })).toBeTruthy();
    expect(within(table()).getByText('SOC')).toBeTruthy();
    expect(within(table()).getAllByText('All teams (global)')).toHaveLength(2);
    // "All macros" mixes scopes: no reorder controls.
    expect(screen.queryByRole('button', { name: /Move .* down/ })).toBeNull();
    expect(screen.getByText(/show one team \(or the global macros\) first/)).toBeTruthy();

    await choose(screen.getByRole('combobox', { name: 'Show' }), 'All teams (global)');
    fireEvent.click(await screen.findByRole('button', { name: 'Move Thanks down' }));
    await waitFor(() => expect(fake.api.sent('POST', /reorder$/)).toHaveLength(1));
    expect(fake.api.sent('POST', /reorder$/)[0]).toEqual({
      teamId: null,
      ids: [GLOBAL_2.id, GLOBAL_1.id],
      expectedIds: [GLOBAL_1.id, GLOBAL_2.id],
    });
  });

  it('creates a global macro: variables inserted, unknown ones refused before sending', async () => {
    withList();
    fake.api.on('POST', /^\/admin\/macros$/, { item: macroRow(9, { titleEn: 'Welcome' }) });
    renderSetup(<MacrosSection role="SUPER_ADMIN" userId={IDS.staff} />);
    await within(table()).findByRole('button', { name: /^Thanks/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const dialog = sheet();
    type(within(dialog).getByRole('textbox', { name: 'Title English' }), 'Welcome');
    expect(within(dialog).getByRole('combobox', { name: /^Available to/ }).textContent).toBe(
      'All teams (global)',
    );
    const body = within(dialog).getByRole('textbox', { name: /^Reply English/ });
    type(body, 'Hi {{name}}');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText('Use only the variables listed below the reply.'),
    ).toBeTruthy();
    expect(fake.api.sent('POST', /macros$/)).toEqual([]);

    type(body, 'Hi ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Insert Client’s first name' }));
    await waitFor(() =>
      expect((body as HTMLTextAreaElement).value).toBe('Hi {{requesterFirstName}}'),
    );
    await choose(
      within(dialog).getByRole('combobox', { name: /^Set status when sent/ }),
      'Pending',
    );
    // The Arabic reply sits behind the English | العربية switch, in its own direction.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'العربية' }));
    const bodyAr = within(dialog).getByRole('textbox', { name: /^Reply Arabic/ });
    expect(bodyAr.getAttribute('dir')).toBe('rtl');
    type(bodyAr, 'مرحبا');
    // The key box shows the suggestion; the API generates the key itself (E4).
    expect(within(dialog).getByRole('textbox', { name: 'Key' })).toHaveProperty('value', 'welcome');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.api.sent('POST', /macros$/)).toHaveLength(1));
    expect(fake.api.sent('POST', /macros$/)[0]).toEqual({
      teamId: null,
      titleEn: 'Welcome',
      titleAr: '',
      bodyEn: 'Hi {{requesterFirstName}}',
      bodyAr: 'مرحبا',
      setStatus: 'PENDING',
    });
  });

  it('moves a macro to a team (super admin) and shows the stale state on a lost update', async () => {
    withList();
    fake.api.on('PATCH', /^\/admin\/macros\/[^/]+$/, () => {
      throw stale();
    });
    renderSetup(<MacrosSection role="SUPER_ADMIN" userId={IDS.staff} />);
    fireEvent.click(await within(table()).findByRole('button', { name: /^Thanks/ }));
    await choose(within(sheet()).getByRole('combobox', { name: /^Available to/ }), 'SOC');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Save' }));
    expect(await within(sheet()).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(fake.api.sent('PATCH', /macros/)).toEqual([
      { teamId: TEAMS.soc.id, expectedUpdatedAt: GLOBAL_1.updatedAt },
    ]);
  });
});

describe('Macros section — team lead (E7)', () => {
  const LEAD_ID = IDS.staff;
  function withDirectory() {
    fake.api.on('GET', /^\/admin\/staff-directory\?/, {
      items: [
        {
          id: LEAD_ID,
          name: 'Tia Lead',
          email: 'tia@loonsgroup.com',
          role: 'TEAM_LEAD',
          jobTitle: null,
          hasPhone: false,
          phoneValid: false,
          teams: [
            { teamId: TEAMS.soc.id, memberRole: 'LEAD' },
            { teamId: TEAMS.elv.id, memberRole: 'MEMBER' },
          ],
        },
      ],
    });
  }

  it('offers only the teams they lead (never global); the scope is fixed when editing', async () => {
    withList([SOC_1]);
    withDirectory();
    renderSetup(<MacrosSection role="TEAM_LEAD" userId={LEAD_ID} />, { role: 'TEAM_LEAD' });
    await within(table()).findByRole('button', { name: /^SOC hello/ });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Show' }), { key: 'Enter' });
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All my teams', 'SOC']);
    fireEvent.keyDown(screen.getByRole('option', { name: 'SOC' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    const scope = within(sheet()).getByRole('combobox', { name: /^Available to/ });
    expect(scope.textContent).toBe('SOC');
    fireEvent.keyDown(scope, { key: 'Enter' });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['SOC']);
    fireEvent.keyDown(screen.getByRole('option', { name: 'SOC' }), { key: 'Enter' });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(table()).getByRole('button', { name: /^SOC hello/ }));
    const locked = within(sheet()).getByRole('combobox', { name: /^Available to/ });
    expect(locked.hasAttribute('disabled')).toBe(true);
    expect(
      within(sheet()).getByText('Only Super Admins can move a macro to another team.'),
    ).toBeTruthy();
  });

  it('leaves the key to the API unless typed: keys of macros they can’t see are unknown', async () => {
    // A global 'engineer-dispatched' exists, but a team lead's list holds only their teams' macros.
    withList([SOC_1]);
    withDirectory();
    fake.api.on('POST', /^\/admin\/macros$/, {
      item: macroRow(9, { key: 'engineer-dispatched-2', titleEn: 'Engineer dispatched' }),
    });
    renderSetup(<MacrosSection role="TEAM_LEAD" userId={LEAD_ID} />, { role: 'TEAM_LEAD' });
    await within(table()).findByRole('button', { name: /^SOC hello/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    type(within(sheet()).getByRole('textbox', { name: 'Title English' }), 'Engineer dispatched');
    const key = within(sheet()).getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    expect(key.value).toBe('engineer-dispatched');
    type(within(sheet()).getByRole('textbox', { name: /^Reply English/ }), 'On the way.');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.api.sent('POST', /macros$/)).toHaveLength(1));
    const first = fake.api.sent('POST', /macros$/)[0] as Record<string, unknown>;
    expect('key' in first).toBe(false);
    expect(first).toMatchObject({ teamId: TEAMS.soc.id, titleEn: 'Engineer dispatched' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The box showed the suggestion; the toast says which key the macro really got.
    expect(toast.success).toHaveBeenCalledWith(
      'Engineer dispatched created with the key engineer-dispatched-2: the suggested key was already taken',
    );

    // A key the admin typed is theirs: it is sent as is.
    fireEvent.click(screen.getByRole('button', { name: 'Create new' }));
    type(within(sheet()).getByRole('textbox', { name: 'Title English' }), 'Engineer dispatched');
    type(within(sheet()).getByRole('textbox', { name: 'Key' }), 'soc-dispatch');
    type(within(sheet()).getByRole('textbox', { name: /^Reply English/ }), 'On the way.');
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fake.api.sent('POST', /macros$/)).toHaveLength(2));
    expect(fake.api.sent('POST', /macros$/)[1]).toMatchObject({ key: 'soc-dispatch' });
  });

  it('a 403 from the API is shown, not swallowed', async () => {
    withList([SOC_1]);
    withDirectory();
    fake.api.on('POST', /macros\/[^/]+\/archive$/, () => {
      throw apiError(403, 'FORBIDDEN');
    });
    renderSetup(<MacrosSection role="TEAM_LEAD" userId={LEAD_ID} />, { role: 'TEAM_LEAD' });
    fireEvent.click(await within(table()).findByRole('button', { name: /^SOC hello/ }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    expect(await within(sheet()).findByText(/have access to this/)).toBeTruthy();
  });

  it('a team lead who leads no team is told so', async () => {
    withList([]);
    fake.api.on('GET', /^\/admin\/staff-directory\?/, { items: [] });
    renderSetup(<MacrosSection role="TEAM_LEAD" userId={LEAD_ID} />, { role: 'TEAM_LEAD' });
    expect(await screen.findByText('You don’t lead a team')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create new' }).hasAttribute('disabled')).toBe(true);
  });

  it('speaks Arabic in the Arabic UI', async () => {
    withList();
    renderSetup(<MacrosSection role="SUPER_ADMIN" userId={IDS.staff} />, { locale: 'ar' });
    const grid = await screen.findByRole('table', { name: 'الردود الجاهزة' });
    expect(await within(grid).findByRole('button', { name: /^رد 1/ })).toBeTruthy();
    expect(within(grid).getAllByText('جميع الفرق (عام)').length).toBeGreaterThan(0);
  });
});
