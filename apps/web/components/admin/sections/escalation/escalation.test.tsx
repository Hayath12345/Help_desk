// @vitest-environment jsdom
import type { EscalationRuleAdminDto, StaffDirectoryEntry, TeamAdminDto } from '@loons/shared';
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
import EscalationSection from '.';

// Escalation rules (E13): the global chain and per-team chains, targets / delays / channels,
// warnings, adding a step at the end of a chain (a team's first step starts its own chain), the
// person picker, reorder by keyboard (one request with the expected order), archive / restore
// and the stale 409 — against a fake /admin/escalation.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const TEAM_SOC = '00000000-0000-4000-8000-0000000000a1';
const TEAM_FM = '00000000-0000-4000-8000-0000000000a2';
const TEAM_OLD = '00000000-0000-4000-8000-0000000000a3';
const MAYA = '00000000-0000-4000-8000-0000000000b1';

const api = vi.hoisted(() => ({
  calls: [] as ApiCall[],
  rules: [] as EscalationRuleAdminDto[],
  staff: [] as StaffDirectoryEntry[],
  /** GET /admin/teams (webhooks and on-call users for the draft warnings). */
  teams: [] as TeamAdminDto[],
  failNext: null as ApiRequestError | null,
  /** When set, the reorder request waits for it (the optimistic order stays on screen). */
  holdReorder: null as Promise<void> | null,
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push({ method: 'GET', path });
      if (path.startsWith('/admin/staff-directory')) return { items: clone(api.staff) };
      if (path.startsWith('/admin/teams')) return { items: clone(api.teams) };
      if (path.startsWith('/teams')) {
        return {
          items: [
            {
              id: TEAM_SOC,
              key: 'soc',
              nameEn: 'Cybersecurity / SOC',
              nameAr: 'الأمن السيبراني',
              members: [],
            },
            { id: TEAM_FM, key: 'fm', nameEn: 'Facilities', nameAr: 'المرافق', members: [] },
          ],
        };
      }
      return { items: clone(api.rules) };
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
        const [, , , id, action] = path.split('/');
        if (id === 'reorder') {
          if (api.holdReorder) await api.holdReorder;
          const body = init.json as { ids: string[]; teamId: string | null };
          body.ids.forEach((ruleId, i) => {
            const rule = api.rules.find((r) => r.id === ruleId)!;
            rule.step = i + 1;
          });
          return undefined;
        }
        if (!id) {
          const body = init.json as Record<string, unknown>;
          const item = rule(api.rules.length + 10, {
            teamId: body.teamId as string | null,
            step: body.step as number,
            targetType: body.targetType as EscalationRuleAdminDto['targetType'],
            targetRole: body.targetRole as EscalationRuleAdminDto['targetRole'],
            targetUser: body.targetUserId ? { id: MAYA, name: 'Maya Ruiz', isActive: true } : null,
            afterMins: body.afterMins as number,
            channels: body.channels as EscalationRuleAdminDto['channels'],
            updatedAt,
          });
          api.rules.push(item);
          return { item: clone(item) };
        }
        const index = api.rules.findIndex((r) => r.id === id);
        const current = api.rules[index]!;
        const body = init.json as Record<string, unknown>;
        const next =
          action === 'archive' || action === 'restore'
            ? { ...current, isActive: action === 'restore', updatedAt }
            : {
                ...current,
                targetType: body.targetType as EscalationRuleAdminDto['targetType'],
                targetRole: body.targetRole as EscalationRuleAdminDto['targetRole'],
                afterMins: body.afterMins as number,
                channels: body.channels as EscalationRuleAdminDto['channels'],
                updatedAt,
              };
        api.rules[index] = next;
        return { item: clone(next) };
      },
    ),
  },
}));

const STAMP = '2026-09-23T12:00:00.000Z';
function adminTeam(
  id: string,
  nameEn: string,
  overrides: Partial<TeamAdminDto> = {},
): TeamAdminDto {
  return {
    id,
    key: nameEn.toLowerCase().slice(0, 3),
    nameEn,
    nameAr: nameEn,
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

function rule(n: number, overrides: Partial<EscalationRuleAdminDto> = {}): EscalationRuleAdminDto {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    priority: 'P1',
    teamId: null,
    team: null,
    step: n,
    targetType: 'ON_CALL',
    targetRole: null,
    targetUser: null,
    afterMins: 0,
    channels: ['EMAIL', 'TEAMS', 'SMS'],
    isActive: true,
    warnings: [],
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.calls = [];
  api.failNext = null;
  api.holdReorder = null;
  // SOC is ready (own chain, webhook, on-call user with a phone); Facilities (on the global chain)
  // has neither a webhook nor an on-call user.
  api.teams = [
    adminTeam(TEAM_SOC, 'Cybersecurity / SOC', {
      teamsWebhook: { configured: true, host: 'contoso.webhook.office.com' },
      onCallUser: { id: MAYA, name: 'Maya Ruiz', phoneValid: true, isMember: true, isActive: true },
    }),
    adminTeam(TEAM_FM, 'Facilities'),
  ];
  api.rules = [
    rule(1, { warnings: ['on_call_missing'] }),
    rule(2, {
      targetType: 'ROLE',
      targetRole: 'TEAM_LEAD',
      afterMins: 5,
      channels: ['EMAIL', 'SMS'],
    }),
    rule(3, {
      targetType: 'USER',
      targetUser: { id: MAYA, name: 'Maya Ruiz', isActive: true },
      afterMins: 15,
      channels: ['EMAIL'],
    }),
    rule(4, {
      step: 1,
      teamId: TEAM_SOC,
      team: {
        id: TEAM_SOC,
        key: 'soc',
        nameEn: 'Cybersecurity / SOC',
        nameAr: 'الأمن السيبراني',
        isActive: true,
      },
    }),
    rule(5, { step: 4, isActive: false, afterMins: 30 }),
  ];
  api.staff = [
    {
      id: MAYA,
      name: 'Maya Ruiz',
      email: 'maya@loons.qa',
      role: 'TEAM_LEAD',
      jobTitle: 'Operations manager',
      hasPhone: true,
      phoneValid: false,
      teams: [],
    },
  ];
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

const table = () => screen.findByRole('table', { name: /^Escalation steps/ });
const rowsOf = async () => {
  const t = await table();
  return waitFor(() => {
    const rows = within(t).getAllByRole('row').slice(1);
    if (!rows[0]?.textContent) throw new Error('loading');
    return rows;
  });
};

describe('escalation rules section', () => {
  it('shows the global chain with targets, delays, channels and warnings', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Step 1, On-call user.*At once.*Email.*SMS.*Teams/),
      expect.stringMatching(/Step 2, Team leads.*After 5 min.*Email.*SMS/),
      expect.stringMatching(/Step 3, Maya Ruiz.*After 15 min.*Email/),
    ]);
    expect(
      within(rows[0]!).getByText('Some teams on this chain have no on-call user.'),
    ).toBeTruthy();
    expect(screen.getByText('1 archived item is hidden.')).toBeTruthy();
    expect(screen.getByText(/The global chain pages every team/)).toBeTruthy();
  });

  it('switches to a team chain; a team without its own chain says it uses the global one', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    await rowsOf();
    await choose(screen.getByLabelText('Chain'), 'Cybersecurity / SOC — own chain');
    await waitFor(async () => expect(await rowsOf()).toHaveLength(1));
    expect(screen.getByText(/This team’s own chain replaces the global chain/)).toBeTruthy();
    await choose(screen.getByLabelText('Chain'), 'Facilities — uses the global chain');
    expect(await screen.findByText('This team uses the global chain')).toBeTruthy();
    // Its first step starts its own chain: the sheet says so and sends the team id.
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add step 1' });
    expect(within(sheet).getByText(/first step of Facilities’s own chain/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        teamId: TEAM_FM,
        step: 1,
        targetType: 'ON_CALL',
        targetRole: null,
        targetUserId: null,
        afterMins: 0,
        channels: ['EMAIL', 'SMS'],
      }),
    );
  });

  it('adds a step at the end of the chain (after archived ones) for a chosen person', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add step 5' });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Person' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(await within(sheet).findByText('Choose a person.')).toBeTruthy();
    await choose(within(sheet).getByLabelText(/^Person/), 'Maya Ruiz');
    // SMS is chosen by default and Maya has no usable phone: said before saving.
    expect(within(sheet).getByText('This person has no phone number for SMS.')).toBeTruthy();
    const delay = within(sheet).getByRole('group', { name: /^When, after the ticket became P1/ });
    const [hours, minutes] = within(delay).getAllByRole('textbox');
    // The default delay follows the last active step (15 min + 5).
    expect((minutes as HTMLInputElement).value).toBe('20');
    fireEvent.change(hours!, { target: { value: '1' } });
    fireEvent.change(minutes!, { target: { value: '0' } });
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'SMS' }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Teams' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toEqual({
        teamId: null,
        step: 5,
        targetType: 'USER',
        targetRole: null,
        targetUserId: MAYA,
        afterMins: 60,
        channels: ['EMAIL', 'TEAMS'],
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Step 5 added'));
  });

  it('needs at least one channel and a delay of at most 7 days', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Step 2[^a-z]*Team/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Step 2' });
    for (const name of ['Email', 'SMS'])
      fireEvent.click(within(sheet).getByRole('checkbox', { name }));
    const [hours] = within(within(sheet).getByRole('group', { name: /^When/ })).getAllByRole(
      'textbox',
    );
    fireEvent.change(hours!, { target: { value: '169' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText('Choose at least one channel.')).toBeTruthy();
    expect(within(sheet).getByText('Use at most 7 days (168 hours).')).toBeTruthy();
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('edits a step with expectedUpdatedAt; switching the role clears nothing else', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Step 2[^a-z]*Team/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Step 2' });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Super admins' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')).toEqual({
        method: 'PATCH',
        path: `/admin/escalation/${api.rules[1]!.id}`,
        body: {
          expectedUpdatedAt: STAMP,
          targetType: 'ROLE',
          targetRole: 'SUPER_ADMIN',
          targetUserId: null,
          afterMins: 5,
          channels: ['EMAIL', 'SMS'],
        },
      }),
    );
  });

  it('reorders by keyboard: one request with the expected and the new order', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    const ids = api.rules.slice(0, 3).map((r) => r.id);
    fireEvent.click(
      within(rows[0]!).getByRole('button', { name: /Move Step 1, On-call user down/ }),
    );
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === '/admin/escalation/reorder')).toEqual({
        method: 'POST',
        path: '/admin/escalation/reorder',
        body: { teamId: null, expectedIds: ids, ids: [ids[1], ids[0], ids[2]] },
      }),
    );
    expect(await screen.findByText(/moved to position 2 of 3/)).toBeTruthy();
  });

  it('archives and restores a step; a stale 409 offers a reload', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    fireEvent.click(within(rows[2]!).getByRole('button', { name: /^Step 3[^a-z]*Maya/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Step 3' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/stops paging anyone/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path.endsWith('/archive'))?.body).toEqual({
        expectedUpdatedAt: STAMP,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const archivedRow = await within(await table()).findByText('Step 4');
    fireEvent.click(archivedRow.closest('button')!);
    sheet = await screen.findByRole('dialog', { name: 'Step 4' });
    api.failNext = new ApiRequestError(409, 'CONFLICT', 'changed', undefined, { reason: 'stale' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore' }));
    expect(await within(sheet).findByText('Someone else changed this — reload')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(within(sheet).queryByText('Someone else changed this — reload')).toBeNull(),
    );
    fireEvent.click(within(sheet).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Step 4 restored'));
  });

  it('names the chosen person even when the directory does not list them; disabled ones say so', async () => {
    api.staff = [];
    api.rules[1] = {
      ...api.rules[1]!,
      targetType: 'USER',
      targetRole: null,
      targetUser: { id: '00000000-0000-4000-8000-0000000000b2', name: 'Omar Old', isActive: false },
    };
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    expect(within(rows[1]!).getByText('Omar Old (disabled)')).toBeTruthy();
    fireEvent.click(within(rows[2]!).getByRole('button', { name: /^Step 3[^a-z]*Maya/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Step 3' });
    await waitFor(() =>
      expect(within(sheet).getByLabelText(/^Person/).textContent).toBe('Maya Ruiz'),
    );
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Step 2[^a-z]*Omar/ }));
    const other = await screen.findByRole('dialog', { name: 'Step 2' });
    await waitFor(() =>
      expect(within(other).getByLabelText(/^Person/).textContent).toBe('Omar Old (disabled)'),
    );
  });

  it('the sheet warns about the draft as the target and channels are chosen (E13)', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    await rowsOf();
    // A new step for Facilities (no webhook, no on-call user).
    await choose(screen.getByLabelText('Chain'), 'Facilities — uses the global chain');
    await screen.findByText('This team uses the global chain');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add step 1' });
    expect(await within(sheet).findByText('The team has no on-call user.')).toBeTruthy();
    const teamsWarning = 'Teams is chosen, but the team has no Teams webhook.';
    expect(within(sheet).queryByText(teamsWarning)).toBeNull();
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Teams' }));
    expect(await within(sheet).findByText(teamsWarning)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Role' }));
    await waitFor(() =>
      expect(within(sheet).queryByText('The team has no on-call user.')).toBeNull(),
    );
    expect(within(sheet).getByText(teamsWarning)).toBeTruthy();
  });

  it('editing a step: its warnings follow the draft, not the saved rule', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    // Global step 2 (team leads, Email + SMS): no warning until Teams is ticked (Facilities is on
    // the global chain and has no webhook).
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Step 2[^a-z]*Team/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Step 2' });
    const teamsWarning = 'Teams is chosen, but some teams on this chain have no Teams webhook.';
    // The live region is there (and never display:none) while it is still empty, so the first
    // warning that appears is announced.
    const region = sheet.querySelector('[data-slot="draft-warnings"]');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('');
    expect(region?.className ?? '').not.toMatch(/(^|\s)(empty:)?hidden(\s|$)/);
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Teams' }));
    expect(await within(sheet).findByText(teamsWarning)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Teams' }));
    await waitFor(() => expect(within(sheet).queryByText(teamsWarning)).toBeNull());
    fireEvent.keyDown(sheet, { key: 'Escape' });
    const discard = await screen.findByRole('alertdialog').catch(() => null);
    if (discard) fireEvent.click(within(discard).getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Global step 1 (on-call, saved with "no on-call user"): paging a role instead clears it.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /^Step 1[^a-z]*On-call/ }));
    sheet = await screen.findByRole('dialog', { name: 'Step 1' });
    const onCall = 'Some teams on this chain have no on-call user.';
    expect(await within(sheet).findByText(onCall)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Role' }));
    await waitFor(() => expect(within(sheet).queryByText(onCall)).toBeNull());
  });

  it('an archived team’s chain is marked archived and takes no new step', async () => {
    api.rules.push(
      rule(6, {
        step: 1,
        teamId: TEAM_OLD,
        team: {
          id: TEAM_OLD,
          key: 'pbx',
          nameEn: 'Old PBX',
          nameAr: 'المقسم القديم',
          isActive: false,
        },
        isActive: false,
      }),
    );
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    await rowsOf();
    expect(screen.getByRole('button', { name: 'Add step' })).toHaveProperty('disabled', false);
    await choose(screen.getByLabelText('Chain'), 'Old PBX — archived team');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add step' })).toHaveProperty('disabled', true),
    );
    expect(screen.getAllByText(/This team is archived/).length).toBeGreaterThan(0);
  });

  it('a refused save or restore that no field can show is said at the top of the sheet', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    await rowsOf();
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add step 5' });
    api.failNext = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      { location: 'body', path: ['teamId'], message: 'validation.invalid', code: 'team' },
    ]);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect((await within(sheet).findByRole('alert')).textContent).toContain('Check this value.');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Restoring a step whose delay no longer fits the chain.
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    const archivedRow = await within(await table()).findByText('Step 4');
    fireEvent.click(archivedRow.closest('button')!);
    const restore = await screen.findByRole('dialog', { name: 'Step 4' });
    api.failNext = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      {
        location: 'body',
        path: ['afterMins'],
        message: 'validation.chainOrder',
        code: 'chain_order',
      },
    ]);
    fireEvent.click(within(restore).getByRole('button', { name: 'Restore' }));
    expect((await within(restore).findByRole('alert')).textContent).toContain(
      'Keep the steps in time order',
    );
  });

  it('a delay out of the chain’s order is shown on the delay field', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Step 2[^a-z]*Team/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Step 2' });
    const [, minutes] = within(within(sheet).getByRole('group', { name: /^When/ })).getAllByRole(
      'textbox',
    );
    fireEvent.change(minutes!, { target: { value: '20' } });
    api.failNext = new ApiRequestError(400, 'VALIDATION_FAILED', 'bad', undefined, [
      {
        location: 'body',
        path: ['afterMins'],
        message: 'validation.chainOrder',
        code: 'chain_order',
      },
    ]);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByText(/^Keep the steps in time order/)).toBeTruthy();
    expect(within(sheet).queryByRole('alert')).toBeNull();
  });

  it('a reorder keeps each step’s time: the moved targets take the delays of their places', async () => {
    let release = () => {};
    api.holdReorder = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />);
    const rows = await rowsOf();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Move Step 2, Team leads up/ }));
    await waitFor(async () =>
      expect((await rowsOf()).map((r) => r.textContent)).toEqual([
        expect.stringMatching(/Step 1, Team leads.*At once/),
        expect.stringMatching(/Step 2, On-call user.*After 5 min/),
        expect.stringMatching(/Step 3, Maya Ruiz.*After 15 min/),
      ]),
    );
    release();
  });

  it('renders in Arabic, right to left', async () => {
    renderSla(<EscalationSection role="SUPER_ADMIN" userId="u1" />, { locale: 'ar' });
    const t = await screen.findByRole('table', { name: /^خطوات التصعيد/ });
    await waitFor(() => expect(within(t).getByText('الخطوة 1')).toBeTruthy());
    expect(within(t).getAllByText('المناوب').length).toBeGreaterThan(0);
    expect(within(t).getByText('بعد 5 دقيقة')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'إضافة خطوة' })).toBeTruthy();
    expect(document.querySelector('[dir="rtl"]')).toBeTruthy();
  });
});
