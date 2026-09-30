// @vitest-environment jsdom
import type { StaffDirectoryEntry, TeamAdminDto, TeamMemberAdminDto } from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import arPeople from '@/messages/ar/admin-people.json';
import TeamsSection from './index';
import {
  conflict,
  createFakeApi,
  invalid,
  pick,
  renderSection,
  settle,
  stubBrowserApis,
  type,
  type FakeApi,
} from './people-test-utils';

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

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const LEAD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MONA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NABIL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OMAR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STAMP = '2026-09-29T10:00:00.000Z';

function member(
  userId: string,
  name: string,
  overrides: Partial<TeamMemberAdminDto> = {},
): TeamMemberAdminDto {
  return {
    userId,
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@loonsgroup.com`,
    role: 'AGENT',
    status: 'ACTIVE',
    memberRole: 'MEMBER',
    hasPhone: true,
    phoneValid: true,
    since: STAMP,
    ...overrides,
  };
}

function team(id: string, nameEn: string, overrides: Partial<TeamAdminDto> = {}): TeamAdminDto {
  return {
    id,
    key: nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    nameEn,
    nameAr: `فريق ${nameEn}`,
    emails: [],
    teamsWebhook: { configured: false, host: null },
    onCallUser: null,
    sortOrder: 0,
    isActive: true,
    members: [],
    activeCategoryCount: 0,
    openTicketCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

let teams: TeamAdminDto[];
const directory: StaffDirectoryEntry[] = [
  {
    id: OMAR,
    name: 'Omar Outsider',
    email: 'omar@loonsgroup.com',
    role: 'AGENT',
    jobTitle: null,
    hasPhone: true,
    phoneValid: true,
    teams: [],
  },
];

function world(fake: FakeApi) {
  fake.on('GET /admin/teams', () => ({ items: teams }));
  fake.on('GET /admin/staff-directory', () => ({ items: directory }));
}

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  teams = [
    team(T1, 'Network Ops', {
      emails: ['noc@loonsgroup.com'],
      teamsWebhook: { configured: true, host: 'contoso.webhook.office.com' },
      members: [
        member(LEAD, 'Tia Lead', { role: 'TEAM_LEAD', memberRole: 'LEAD' }),
        member(MONA, 'Mona Member'),
        member(NABIL, 'Nabil Nophone', { hasPhone: false, phoneValid: false }),
      ],
    }),
    team(T2, 'Security SOC', { sortOrder: 1 }),
    team(T3, 'Legacy PBX', { isActive: false, sortOrder: 2 }),
  ];
  api.current = createFakeApi();
  world(api.current);
});
afterEach(cleanup);

const table = () => screen.getByRole('table', { name: 'Teams & members' });
const sheet = () => screen.getByRole('dialog');

async function openTeam(name: string) {
  fireEvent.click(await within(table()).findByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('Teams & members — Super Admin', () => {
  it('lists active teams with members, on-call and the webhook host; archived behind the switch', async () => {
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    await within(table()).findByText('Network Ops');
    const rows = within(table()).getAllByRole('row');
    expect(rows.map((r) => r.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Network Ops'),
        expect.stringContaining('contoso.webhook.office.com'),
      ]),
    );
    expect(within(table()).getByText('3 members')).toBeTruthy();
    expect(within(table()).queryByText('Legacy PBX')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(await within(table()).findByText('Legacy PBX')).toBeTruthy();
    expect(screen.getByText(/Team Leads see and manage only the teams they lead/)).toBeTruthy();
  });

  it('creates a team: key from the name, email list lower-cased, webhook URL; then shows its members', async () => {
    const created = team('44444444-4444-4444-8444-444444444444', 'Night Shift');
    api.current!.on('POST /admin/teams', () => {
      teams = [...teams, created];
      return { item: created };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create new' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Night Shift');
    type(within(dialog).getByRole('textbox', { name: 'Name العربية' }), 'النوبة الليلية');
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Key' })).toHaveProperty(
        'value',
        'night-shift',
      ),
    );
    type(
      within(dialog).getByRole('textbox', { name: /Team email list/ }),
      'Ops@Example.com\nnoc@example.com',
    );
    type(within(dialog).getByLabelText('New webhook URL'), 'https://x.webhook.office.com/abc');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]).toMatchObject({
      method: 'POST',
      path: '/admin/teams',
      body: {
        key: 'night-shift',
        nameEn: 'Night Shift',
        nameAr: 'النوبة الليلية',
        emails: ['Ops@Example.com', 'noc@example.com'],
        teamsWebhookUrl: 'https://x.webhook.office.com/abc',
      },
    });
    expect(await screen.findByRole('dialog', { name: 'Edit Night Shift' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Night Shift created');
  });

  it('shows validation errors from the form and from the API on their fields', async () => {
    api.current!.on('POST /admin/teams', () => {
      throw invalid([{ path: ['teamsWebhookUrl'], message: 'validation.webhookHost' }]);
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create new' }));
    const dialog = await screen.findByRole('dialog', { name: 'New team' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('This field is required.')).toBeTruthy();
    expect(api.current!.writes()).toHaveLength(0);
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Hooked');
    type(within(dialog).getByLabelText('New webhook URL'), 'https://evil.example.com/x');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(
      await within(dialog).findByText(/This host isn't allowed for Teams webhooks/),
    ).toBeTruthy();
  });

  it('saves only the changed fields with expectedUpdatedAt; a stale save shows reload', async () => {
    let fail = true;
    api.current!.on('PATCH /admin/teams/' + T1, () => {
      if (fail) throw conflict({ reason: 'stale', currentUpdatedAt: STAMP });
      teams = teams.map((t) => (t.id === T1 ? { ...t, nameEn: 'Network' } : t));
      return { item: teams[0] };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Network');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      nameEn: 'Network',
      expectedUpdatedAt: STAMP,
    });
    expect(toast.error).not.toHaveBeenCalled();
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(dialog).queryByText(/Someone else changed/)).toBeNull());
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Network');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('Team saved');
  });

  it('sends the version the edit started from: a concurrent change is not reverted (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on('PATCH /admin/teams/' + T1, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    type(
      within(dialog).getByRole('textbox', { name: /Team email list/ }),
      'noc@loonsgroup.com\nops@loonsgroup.com',
    );
    // Another admin renames the team and moves the on-call user; the list refetches.
    teams = teams.map((t) =>
      t.id === T1
        ? {
            ...t,
            nameEn: 'Network Operations',
            onCallUser: {
              id: MONA,
              name: 'Mona Member',
              isActive: true,
              isMember: true,
              phoneValid: true,
            },
            updatedAt: NEWER,
          }
        : t,
    );
    await queryClient.invalidateQueries();
    await screen.findByRole('dialog', { name: 'Edit Network Operations' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      emails: ['noc@loonsgroup.com', 'ops@loonsgroup.com'],
      expectedUpdatedAt: STAMP,
    });
  });

  it('loads a newer version while the form is untouched, and saves against it', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on('PATCH /admin/teams/' + T1, () => ({ item: teams[0] }));
    const { queryClient } = renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    teams = teams.map((t) =>
      t.id === T1 ? { ...t, nameEn: 'Network Operations', updatedAt: NEWER } : t,
    );
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Name English' })).toHaveProperty(
        'value',
        'Network Operations',
      ),
    );
    type(within(dialog).getByRole('textbox', { name: 'Name العربية' }), 'العمليات');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      nameAr: 'العمليات',
      expectedUpdatedAt: NEWER,
    });
  });

  it('Reload loads the newest version: the next save is sent against it (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    const NEWEST = '2026-09-29T12:00:00.000Z';
    // The API checks the version the way lockFresh does.
    api.current!.on('PATCH /admin/teams/' + T1, (call) => {
      const current = teams.find((t) => t.id === T1)!;
      if ((call.body as { expectedUpdatedAt: string }).expectedUpdatedAt !== current.updatedAt) {
        throw conflict({ reason: 'stale', currentUpdatedAt: current.updatedAt });
      }
      return { item: current };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    teams = teams.map((t) => (t.id === T1 ? { ...t, nameAr: 'فريق آخر', updatedAt: NEWER } : t));
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Network');
    const listCalls = () => api.current!.calls.filter((c) => c.path === '/admin/teams').length;
    const fetched = listCalls();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    // The refetch after the refused save has landed (the list now shows NEWER)…
    await waitFor(() => expect(listCalls()).toBeGreaterThan(fetched));
    await settle();
    await settle();
    // …and another change lands after it: only Reload fetches that one.
    teams = teams.map((t) => (t.id === T1 ? { ...t, updatedAt: NEWEST } : t));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(dialog).queryByText(/Someone else changed/)).toBeNull());
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Network');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.current!.writes()[1]?.body).toEqual({
      nameEn: 'Network',
      expectedUpdatedAt: NEWEST,
    });
  });

  it('a role change made in the sheet does not make its own save stale (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on(`PATCH /admin/teams/${T1}/members/${MONA}`, (call) => {
      const body = call.body as { expectedUpdatedAt: string; memberRole: 'LEAD' | 'MEMBER' };
      const current = teams.find((t) => t.id === T1)!;
      if (body.expectedUpdatedAt !== current.updatedAt) {
        throw conflict({ reason: 'stale', currentUpdatedAt: current.updatedAt });
      }
      teams = teams.map((t) =>
        t.id === T1
          ? {
              ...t,
              updatedAt: NEWER,
              members: t.members.map((m) =>
                m.userId === MONA ? { ...m, memberRole: body.memberRole } : m,
              ),
            }
          : t,
      );
      return {
        item: member(MONA, 'Mona Member', { memberRole: body.memberRole }),
        teamUpdatedAt: NEWER,
      };
    });
    api.current!.on('PATCH /admin/teams/' + T1, (call) => {
      const current = teams.find((t) => t.id === T1)!;
      if ((call.body as { expectedUpdatedAt: string }).expectedUpdatedAt !== current.updatedAt) {
        throw conflict({ reason: 'stale', currentUpdatedAt: current.updatedAt });
      }
      return { item: { ...current, nameEn: 'Network Operations' } };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Network Operations');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make lead — Mona Member' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mona Member is now a Lead'));
    await within(dialog).findByRole('button', { name: 'Make member — Mona Member' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.current!.writes()[1]?.body).toEqual({
      nameEn: 'Network Operations',
      expectedUpdatedAt: NEWER,
    });
    expect(screen.queryByText(/Someone else changed/)).toBeNull();
  });

  it('two role changes in a row: the second is sent against the first one’s version', async () => {
    const versions = [
      '2026-09-29T11:00:00.000Z',
      '2026-09-29T12:00:00.000Z',
      '2026-09-29T13:00:00.000Z',
    ];
    let release: () => void = () => {};
    let hold: Promise<void> | null = null;
    api.current!.on('GET /admin/teams', async () => {
      // The list refetch after the first change is slow to arrive.
      if (hold) await hold;
      return { items: teams };
    });
    api.current!.on(`PATCH /admin/teams/${T1}/members/${MONA}`, (call) => {
      const body = call.body as { expectedUpdatedAt: string; memberRole: 'LEAD' | 'MEMBER' };
      const current = teams.find((t) => t.id === T1)!;
      if (body.expectedUpdatedAt !== current.updatedAt) {
        throw conflict({ reason: 'stale', currentUpdatedAt: current.updatedAt });
      }
      const next = versions.shift()!;
      teams = teams.map((t) =>
        t.id === T1
          ? {
              ...t,
              updatedAt: next,
              members: t.members.map((m) =>
                m.userId === MONA ? { ...m, memberRole: body.memberRole } : m,
              ),
            }
          : t,
      );
      return {
        item: member(MONA, 'Mona Member', { memberRole: body.memberRole }),
        teamUpdatedAt: next,
      };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    hold = new Promise((resolve) => (release = resolve));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make lead — Mona Member' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mona Member is now a Lead'));
    await settle();
    // The list still shows the old version and role: the second click comes before it refreshes.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make lead — Mona Member' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(2));
    expect(api.current!.writes()[1]?.body).toMatchObject({
      expectedUpdatedAt: '2026-09-29T11:00:00.000Z',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    await settle();
    // A third one, still before the list refreshes: sent against the second one's version.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make lead — Mona Member' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(3));
    expect(api.current!.writes()[2]?.body).toMatchObject({
      expectedUpdatedAt: '2026-09-29T12:00:00.000Z',
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(3));
    release();
    await settle();
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('Replace URL needs a URL: an empty one is an error, not a silent keep', async () => {
    api.current!.on('PATCH /admin/teams/' + T1, () => ({ item: teams[0] }));
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Replace URL' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('This field is required.')).toBeTruthy();
    // Focus goes to the field the error is about.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByLabelText('New webhook URL')),
    );
    expect(api.current!.writes()).toHaveLength(0);
    expect(screen.getByRole('dialog')).toBe(dialog);
    type(within(dialog).getByLabelText('New webhook URL'), 'https://x.webhook.office.com/new');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      teamsWebhookUrl: 'https://x.webhook.office.com/new',
      expectedUpdatedAt: STAMP,
    });
  });

  it('replaces or removes the webhook without ever showing the URL', async () => {
    api.current!.on('PATCH /admin/teams/' + T1, () => ({ item: teams[0] }));
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    expect(within(dialog).getByText('Configured · contoso.webhook.office.com')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Remove webhook' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      teamsWebhookUrl: null,
      expectedUpdatedAt: STAMP,
    });
  });

  it('archives; a guard refusal is explained in the sheet', async () => {
    api.current!.on(`POST /admin/teams/${T1}/archive`, () => {
      throw conflict({ reason: 'guard', guard: 'team_has_open_tickets' });
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Archive Network Ops?' });
    expect(within(confirm).getByText(/while active categories route to it/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    expect(
      await within(sheet()).findByText(
        'This team still has open tickets. Solve or move them first.',
      ),
    ).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({ expectedUpdatedAt: STAMP });
  });

  it('restores an archived team', async () => {
    api.current!.on(`POST /admin/teams/${T3}/restore`, () => ({
      item: { ...teams[2]!, isActive: true },
    }));
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show archived' }));
    const dialog = await openTeam('Legacy PBX');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Legacy PBX restored'));
  });

  it('reorders with Move down (one request with the expected order)', async () => {
    api.current!.on('POST /admin/teams/reorder', () => undefined);
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Network Ops down' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]).toMatchObject({
      path: '/admin/teams/reorder',
      body: { ids: [T2, T1], expectedIds: [T1, T2] },
    });
  });

  it('promotes a member to lead and removes a member after confirming', async () => {
    api.current!.on(`PATCH /admin/teams/${T1}/members/${MONA}`, () => ({
      item: member(MONA, 'Mona Member', { memberRole: 'LEAD' }),
      teamUpdatedAt: '2026-09-29T11:00:00.000Z',
    }));
    api.current!.on(`DELETE /admin/teams/${T1}/members/${NABIL}`, () => ({
      item: member(NABIL, 'Nabil Nophone'),
    }));
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make lead — Mona Member' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Mona Member is now a Lead'));
    // The team's updatedAt: a role change is an edit of the team (E19).
    expect(api.current!.writes()[0]?.body).toEqual({
      memberRole: 'LEAD',
      expectedUpdatedAt: STAMP,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Nabil Nophone' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Nabil Nophone from Network Ops?',
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove Nabil Nophone' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(2));
    expect(api.current!.writes()[1]).toMatchObject({
      method: 'DELETE',
      path: `/admin/teams/${T1}/members/${NABIL}`,
    });
  });
});

describe('Teams & members — keyboard focus', () => {
  it('removing a member moves focus to the next member’s Remove button', async () => {
    api.current!.on(`DELETE /admin/teams/${T1}/members/${MONA}`, () => {
      teams = [
        { ...teams[0]!, members: teams[0]!.members.filter((m) => m.userId !== MONA) },
        ...teams.slice(1),
      ];
      return { item: member(MONA, 'Mona Member') };
    });
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    const remove = within(dialog).getByRole('button', { name: 'Remove Mona Member' });
    remove.focus();
    fireEvent.click(remove);
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Mona Member from Network Ops?',
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove Mona Member' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Remove Nabil Nophone' }),
      ),
    );
  });
});

describe('Teams & members — Team Lead (E7)', () => {
  beforeEach(() => {
    teams = [teams[0]!];
  });

  it('has no Create new or reorder; settings are read-only; only on-call and members change', async () => {
    api.current!.on('PATCH /admin/teams/' + T1, () => ({ item: teams[0] }));
    renderSection(<TeamsSection role="TEAM_LEAD" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    expect(screen.queryByRole('button', { name: 'Create new' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(within(dialog).getByText(/Names, email lists, the Teams webhook/)).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Name English' })).toHaveProperty(
      'disabled',
      true,
    );
    // The email list is locked like the names (not a normal-looking read-only box).
    expect(within(dialog).getByRole('textbox', { name: /Team email list/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(within(dialog).queryByRole('radio', { name: 'Remove webhook' })).toBeNull();
    // Only members with an international phone can be on call.
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'On-call user' }));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByRole('option', { name: /Nabil Nophone/ })).toBeNull();
    fireEvent.keyDown(listbox, { key: 'Escape' });
    await pick(within(dialog).getByRole('combobox', { name: 'On-call user' }), 'Mona Member');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      onCallUserId: MONA,
      expectedUpdatedAt: STAMP,
    });
  });

  it('never sends the email list, and a concurrent change is not reverted (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on('PATCH /admin/teams/' + T1, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<TeamsSection role="TEAM_LEAD" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    await pick(within(dialog).getByRole('combobox', { name: 'On-call user' }), 'Mona Member');
    // A Super Admin edits the team's email list meanwhile; the list refetches.
    teams = teams.map((t) =>
      t.id === T1 ? { ...t, emails: ['soc@loonsgroup.com'], updatedAt: NEWER } : t,
    );
    await queryClient.invalidateQueries();
    await settle();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      onCallUserId: MONA,
      expectedUpdatedAt: STAMP,
    });
  });

  it('closes the sheet when the open team leaves the list (lead role removed)', async () => {
    const { queryClient } = renderSection(<TeamsSection role="TEAM_LEAD" userId={LEAD} />);
    await openTeam('Network Ops');
    teams = [];
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/Create the team first/)).toBeNull();
    // The lead role comes back: the sheet stays closed (it does not reopen by itself).
    teams = [team(T1, 'Network Ops')];
    await queryClient.invalidateQueries();
    await within(table()).findByRole('button', { name: 'Network Ops' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds members as MEMBER only and cannot remove or change leads', async () => {
    api.current!.on(`POST /admin/teams/${T1}/members`, () => ({
      item: member(OMAR, 'Omar Outsider'),
    }));
    renderSection(<TeamsSection role="TEAM_LEAD" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    expect(within(dialog).queryByRole('button', { name: 'Remove Tia Lead' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Remove Mona Member' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /^Make / })).toBeNull();
    expect(within(dialog).queryByRole('radiogroup', { name: 'Add as' })).toBeNull();
    await pick(within(dialog).getByRole('combobox', { name: 'Person' }), 'Omar Outsider');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add member' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]).toMatchObject({
      path: `/admin/teams/${T1}/members`,
      body: { userId: OMAR, memberRole: 'MEMBER' },
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Omar Outsider added to the team'),
    );
  });

  it('shows the API refusal of a member change (409 guard) in the members panel', async () => {
    api.current!.on(`DELETE /admin/teams/${T1}/members/${MONA}`, () => {
      throw conflict({ reason: 'guard', guard: 'member_is_on_call' });
    });
    renderSection(<TeamsSection role="TEAM_LEAD" userId={LEAD} />);
    const dialog = await openTeam('Network Ops');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Mona Member' }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove Mona Member' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "This member is the team's on-call contact. Choose another on-call user first.",
    );
  });
});

describe('Teams & members — Arabic', () => {
  it('renders in Arabic, right to left', async () => {
    renderSection(<TeamsSection role="SUPER_ADMIN" userId={LEAD} />, 'ar');
    const arTable = await screen.findByRole('table', { name: 'الفرق والأعضاء' });
    expect(await within(arTable).findByText('فريق Network Ops')).toBeTruthy();
    expect(within(arTable).getByText('3 أعضاء')).toBeTruthy();
    expect(arTable.closest('[dir]')?.getAttribute('dir')).toBe('rtl');
    fireEvent.click(within(arTable).getByRole('button', { name: 'فريق Network Ops' }));
    const dialog = await screen.findByRole('dialog', { name: 'تعديل فريق Network Ops' });
    expect(within(dialog).getByText(arPeople.teams.members.title)).toBeTruthy();
    await settle();
  });
});
