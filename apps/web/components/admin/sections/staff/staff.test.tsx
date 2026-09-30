// @vitest-environment jsdom
import type { StaffAdminDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conflict,
  createFakeApi,
  invalid,
  renderSection,
  stubBrowserApis,
  type,
  type FakeApi,
} from '../teams/people-test-utils';
import StaffSection from './index';

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

const ME = '11111111-1111-4111-8111-111111111111';
const ALI = '22222222-2222-4222-8222-222222222222';
const DEE = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const STAMP = '2026-09-29T10:00:00.000Z';

function staff(id: string, name: string, overrides: Partial<StaffAdminDto> = {}): StaffAdminDto {
  return {
    id,
    email: `${name.split(' ')[0]!.toLowerCase()}@loonsgroup.com`,
    name,
    role: 'AGENT',
    status: 'ACTIVE',
    jobTitle: null,
    phone: null,
    phoneValid: false,
    teams: [],
    microsoftLinked: false,
    lastLoginAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

let people: StaffAdminDto[];

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  people = [
    staff(ALI, 'Ali Agent', {
      jobTitle: 'Field engineer',
      phone: '+97455501234',
      phoneValid: true,
      microsoftLinked: true,
      teams: [
        {
          id: TEAM,
          key: 'noc',
          nameEn: 'Network Ops',
          nameAr: 'العمليات',
          isActive: true,
          memberRole: 'MEMBER',
        },
      ],
    }),
    staff(ME, 'Sam Admin', { role: 'SUPER_ADMIN' }),
    staff(DEE, 'Dee Disabled', { status: 'DISABLED' }),
  ];
  api.current = createFakeApi();
  api.current.on('GET /admin/staff', (call) => {
    const status = call.query.get('status');
    const role = call.query.get('role');
    const items = people.filter(
      (p) => (status === 'all' || p.status === 'ACTIVE') && (role === null || p.role === role),
    );
    return { items, nextCursor: null };
  });
});
afterEach(cleanup);

const table = () => screen.getByRole('table', { name: 'Staff' });
async function openRow(name: string) {
  fireEvent.click(await within(table()).findByRole('button', { name: new RegExp(`^${name}`) }));
  return screen.findByRole('dialog');
}

describe('Staff', () => {
  it('lists active staff; disabled accounts and role filters go to the API', async () => {
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    expect(await within(table()).findByText('Ali Agent')).toBeTruthy();
    expect(within(table()).getByText('Phone set')).toBeTruthy();
    expect(within(table()).getByText('Microsoft linked')).toBeTruthy();
    expect(within(table()).queryByText('Dee Disabled')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(await within(table()).findByText('Dee Disabled')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Super Admin' }));
    await waitFor(() => expect(within(table()).queryByText('Ali Agent')).toBeNull());
    const last = api.current!.calls.at(-1)!;
    expect(last.query.get('role')).toBe('SUPER_ADMIN');
    expect(last.query.get('status')).toBe('all');
    expect(screen.getByText('Only Super Admins can open this section.')).toBeTruthy();
  });

  it('creates an account (no password) and shows API field errors on the form', async () => {
    let attempt = 0;
    api.current!.on('POST /admin/staff', (call) => {
      attempt += 1;
      if (attempt === 1) {
        throw invalid([{ path: ['email'], message: 'validation.staffDomain' }]);
      }
      const body = call.body as { name: string; email: string };
      return { item: staff('55555555-5555-4555-8555-555555555555', body.name) };
    });
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create new' }));
    const dialog = await screen.findByRole('dialog', { name: 'New staff account' });
    type(within(dialog).getByRole('textbox', { name: /Work email/ }), 'nora@example.com');
    type(within(dialog).getByRole('textbox', { name: /Full name/ }), 'Nora New');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Team Lead' }));
    type(within(dialog).getByRole('textbox', { name: /Mobile phone/ }), '5550');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText('Enter an international number, for example +974 5555 1234.'),
    ).toBeTruthy();
    expect(api.current!.writes()).toHaveLength(0);
    type(within(dialog).getByRole('textbox', { name: /Mobile phone/ }), '+974 5550 1234');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText('Staff accounts need a Loons Group staff email address.'),
    ).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      email: 'nora@example.com',
      name: 'Nora New',
      role: 'TEAM_LEAD',
      jobTitle: null,
      phone: '+974 5550 1234',
    });
    type(within(dialog).getByRole('textbox', { name: /Work email/ }), 'nora@loonsgroup.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Nora New can now sign in with Microsoft');
  });

  it('edits: email locked, teams shown; a role change warns about signing out and sends expectedUpdatedAt', async () => {
    api.current!.on(`PATCH /admin/staff/${ALI}`, () => ({
      item: { ...people[0]!, role: 'TEAM_LEAD' },
    }));
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    const dialog = await openRow('Ali Agent');
    expect(within(dialog).getByRole('textbox', { name: /Work email/ })).toHaveProperty(
      'readOnly',
      true,
    );
    expect(within(dialog).getByText('Network Ops · Member')).toBeTruthy();
    expect(within(dialog).queryByText(/signs this person out/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Team Lead' }));
    expect(within(dialog).getByText(/signs this person out everywhere/)).toBeTruthy();
    type(within(dialog).getByRole('textbox', { name: /Job title/ }), 'Supervisor');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      role: 'TEAM_LEAD',
      jobTitle: 'Supervisor',
      expectedUpdatedAt: STAMP,
    });
  });

  it('sends the version the edit started from: a concurrent role change is not reverted (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on(`PATCH /admin/staff/${ALI}`, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    const dialog = await openRow('Ali Agent');
    type(within(dialog).getByRole('textbox', { name: /Job title/ }), 'Engineer');
    // Another admin promotes Ali meanwhile; the list refetches.
    people = people.map((p) => (p.id === ALI ? { ...p, role: 'TEAM_LEAD', updatedAt: NEWER } : p));
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(api.current!.calls.filter((c) => c.path === '/admin/staff')).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'Agent' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    // The form still shows what the edit started from, and no sign-out warning appears.
    expect(within(dialog).queryByText(/signs this person out/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      jobTitle: 'Engineer',
      expectedUpdatedAt: STAMP,
    });
  });

  it('a concurrent disable is not undone by an unrelated save (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on(`PATCH /admin/staff/${ALI}`, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show archived' }));
    const dialog = await openRow('Ali Agent');
    type(within(dialog).getByRole('textbox', { name: /Job title/ }), 'Engineer');
    // Another admin disables Ali (a compromised account) meanwhile; the list refetches.
    people = people.map((p) => (p.id === ALI ? { ...p, status: 'DISABLED', updatedAt: NEWER } : p));
    const before = api.current!.calls.filter((c) => c.path === '/admin/staff').length;
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(api.current!.calls.filter((c) => c.path === '/admin/staff').length).toBeGreaterThan(
        before,
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    // Never `status: 'ACTIVE'`: that save would re-enable the account.
    expect(api.current!.writes()[0]?.body).toEqual({
      jobTitle: 'Engineer',
      expectedUpdatedAt: STAMP,
    });
  });

  it('locks your own role and status', async () => {
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    const dialog = await openRow('Sam Admin');
    expect(
      within(dialog).getByText("You can't change your own role or disable your own account."),
    ).toBeTruthy();
    for (const radio of within(dialog).getAllByRole('radio')) {
      expect(radio).toHaveProperty('disabled', true);
    }
  });

  it('explains guard and stale refusals', async () => {
    let answer: Error = conflict({ reason: 'guard', guard: 'last_super_admin' });
    api.current!.on(`PATCH /admin/staff/${ALI}`, () => {
      throw answer;
    });
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />);
    const dialog = await openRow('Ali Agent');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Disabled' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        'This is the last active Super Admin. Make someone else a Super Admin first.',
      ),
    ).toBeTruthy();
    answer = conflict({ reason: 'stale', currentUpdatedAt: STAMP });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('renders in Arabic', async () => {
    renderSection(<StaffSection role="SUPER_ADMIN" userId={ME} />, 'ar');
    const arTable = await screen.findByRole('table', { name: 'الموظفون' });
    expect(await within(arTable).findByText('Ali Agent')).toBeTruthy();
    expect(within(arTable).getByText('مرتبط بـ Microsoft')).toBeTruthy();
    expect(within(arTable).getAllByText('موظف دعم').length).toBeGreaterThan(0);
  });
});
