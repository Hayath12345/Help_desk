// @vitest-environment jsdom
import type {
  OrganizationAdminDto,
  PendingSignupDto,
  SiteAdminDto,
  StaffDirectoryEntry,
} from '@loons/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conflict,
  createFakeApi,
  pick,
  renderSection,
  settle,
  stubBrowserApis,
  type,
  type FakeApi,
} from '../teams/people-test-utils';
import ClientsSection from './index';

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

const HMC = '11111111-1111-4111-8111-111111111111';
const QNB = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const HQ = '44444444-4444-4444-8444-444444444444';
const LAB = '55555555-5555-4555-8555-555555555555';
const GONE = '66666666-6666-4666-8666-666666666666';
const MAYA = '77777777-7777-4777-8777-777777777777';
const PAT = '88888888-8888-4888-8888-888888888888';
const STAMP = '2026-09-29T10:00:00.000Z';

function site(id: string, orgId: string, name: string, overrides: Partial<SiteAdminDto> = {}) {
  return {
    id,
    orgId,
    key: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    nameAr: null,
    address: null,
    sortOrder: 0,
    isActive: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  } satisfies SiteAdminDto;
}

function org(id: string, name: string, overrides: Partial<OrganizationAdminDto> = {}) {
  return {
    id,
    key: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    nameAr: null,
    contractType: 'AMC',
    amcExpiry: null,
    accountManager: null,
    emailDomains: [],
    phone: null,
    isActive: true,
    sites: [],
    clientCount: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  } satisfies OrganizationAdminDto;
}

let orgs: OrganizationAdminDto[];
let pending: PendingSignupDto[];
const directory: StaffDirectoryEntry[] = [
  {
    id: MAYA,
    name: 'Maya Manager',
    email: 'maya@loonsgroup.com',
    role: 'AGENT',
    jobTitle: 'Account manager',
    hasPhone: false,
    phoneValid: false,
    teams: [],
  },
];

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  orgs = [
    org(HMC, 'Hamad Medical', {
      nameAr: 'مؤسسة حمد الطبية',
      amcExpiry: '2027-03-31',
      emailDomains: ['hamad.qa'],
      clientCount: 12,
      sites: [
        site(HQ, HMC, 'Head Office', { address: 'West Bay' }),
        site(LAB, HMC, 'Lab', { sortOrder: 1 }),
        site(GONE, HMC, 'Old Annex', { isActive: false, sortOrder: 2 }),
      ],
    }),
    org(QNB, 'QNB', { contractType: 'BILLABLE' }),
    org(OLD, 'Old Client', { isActive: false }),
  ];
  pending = [
    {
      id: PAT,
      name: 'Pat Pending',
      email: 'pat@unknown.example',
      emailDomain: 'unknown.example',
      signupCompany: 'Unknown Co',
      emailVerified: true,
      status: 'PENDING_APPROVAL',
      org: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    },
  ];
  api.current = createFakeApi();
  api.current.on('GET /admin/clients', (call) => ({
    items: orgs.filter((o) => call.query.get('status') === 'all' || o.isActive),
    nextCursor: null,
  }));
  api.current.on('GET /admin/clients/pending-signups', () => ({
    items: pending,
    nextCursor: null,
  }));
  api.current.on('GET /admin/staff-directory', () => ({ items: directory }));
});
afterEach(cleanup);

const table = () => screen.getByRole('table', { name: 'Clients & sites' });
async function openOrg(name: string) {
  fireEvent.click(await within(table()).findByRole('button', { name }));
  return screen.findByRole('dialog');
}

describe('Clients & sites', () => {
  it('lists organisations with contract, AMC expiry, sites and clients', async () => {
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    expect(await within(table()).findByText('Hamad Medical')).toBeTruthy();
    expect(within(table()).getByText('AMC until Mar 31, 2027')).toBeTruthy();
    expect(within(table()).getByText('2 sites')).toBeTruthy();
    expect(within(table()).getByText('12 clients')).toBeTruthy();
    expect(within(table()).queryByText('Old Client')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Pending sign-ups (1)' })).toBeTruthy();
  });

  it('creates an organisation with domains, manager and contract', async () => {
    const created = org('99999999-9999-4999-8999-999999999999', 'Qatar Clinic');
    api.current!.on('POST /admin/clients', () => {
      orgs = [...orgs, created];
      return { item: created };
    });
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create new' }));
    const dialog = await screen.findByRole('dialog', { name: 'New organisation' });
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Qatar Clinic');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Billable' }));
    type(
      within(dialog).getByRole('textbox', { name: /Email domains/ }),
      'Clinic.QA\nclinic.com.qa',
    );
    await pick(within(dialog).getByRole('combobox', { name: /Account manager/ }), 'Maya Manager');
    type(within(dialog).getByRole('textbox', { name: /Phone/ }), '+974 4444 0000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    // The key still follows the name (not typed): the API generates it with its collision suffix.
    expect(api.current!.writes()[0]?.body).toEqual({
      name: 'Qatar Clinic',
      nameAr: null,
      contractType: 'BILLABLE',
      amcExpiry: null,
      accountManagerId: MAYA,
      emailDomains: ['clinic.qa', 'clinic.com.qa'],
      phone: '+974 4444 0000',
    });
    expect(await screen.findByRole('dialog', { name: 'Edit Qatar Clinic' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add site' })).toBeTruthy();
  });

  it('sends a key the admin typed', async () => {
    const created = org('99999999-9999-4999-8999-999999999999', 'Qatar Clinic', { key: 'qc' });
    api.current!.on('POST /admin/clients', () => {
      orgs = [...orgs, created];
      return { item: created };
    });
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create new' }));
    const dialog = await screen.findByRole('dialog', { name: 'New organisation' });
    type(within(dialog).getByRole('textbox', { name: 'Name English' }), 'Qatar Clinic');
    await waitFor(() =>
      expect(within(dialog).getByRole('textbox', { name: 'Key' })).toHaveProperty(
        'value',
        'qatar-clinic',
      ),
    );
    type(within(dialog).getByRole('textbox', { name: 'Key' }), 'qc');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toMatchObject({ key: 'qc', name: 'Qatar Clinic' });
  });

  it('sends the version the edit started from: a concurrent change is not reverted (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on('PATCH /admin/clients/' + HMC, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('Hamad Medical');
    type(within(dialog).getByRole('textbox', { name: /Phone/ }), '+974 4444 0000');
    // Another admin adds a domain and sets the account manager meanwhile; the list refetches.
    orgs = orgs.map((o) =>
      o.id === HMC
        ? {
            ...o,
            emailDomains: ['hamad.qa', 'hmc.org.qa'],
            accountManager: { id: MAYA, name: 'Maya Manager' },
            updatedAt: NEWER,
          }
        : o,
    );
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(
        api.current!.calls.filter((c) => c.method === 'GET' && c.path === '/admin/clients'),
      ).toHaveLength(2),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Someone else changed this — reload')).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      phone: '+974 4444 0000',
      expectedUpdatedAt: STAMP,
    });
  });

  it('a site edit sends the version it started from and only what changed (E19)', async () => {
    const NEWER = '2026-09-29T11:00:00.000Z';
    api.current!.on(`PATCH /admin/clients/${HMC}/sites/${HQ}`, () => {
      throw conflict({ reason: 'stale', currentUpdatedAt: NEWER });
    });
    const { queryClient } = renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('Hamad Medical');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit Head Office' }));
    type(within(dialog).getByRole('textbox', { name: 'Address' }), 'Lusail');
    // Another admin renames the site meanwhile; the list refetches.
    orgs = orgs.map((o) =>
      o.id === HMC
        ? {
            ...o,
            sites: o.sites.map((s) =>
              s.id === HQ ? { ...s, name: 'Headquarters', updatedAt: NEWER } : s,
            ),
          }
        : o,
    );
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(
        api.current!.calls.filter((c) => c.method === 'GET' && c.path === '/admin/clients'),
      ).toHaveLength(2),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save site' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      address: 'Lusail',
      expectedUpdatedAt: STAMP,
    });
    expect(
      await within(dialog).findByText(
        'Someone else changed this in the meantime. Refresh and try again.',
      ),
    ).toBeTruthy();
  });

  it('refuses public mail domains in the form and explains a domain owned by an archived org', async () => {
    api.current!.on('PATCH /admin/clients/' + QNB, () => {
      throw conflict({
        reason: 'duplicate',
        fields: ['emailDomains'],
        existingId: OLD,
        existingIsActive: false,
      });
    });
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('QNB');
    const domains = within(dialog).getByRole('textbox', { name: /Email domains/ });
    type(domains, 'gmail.com');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        "Public mail providers such as gmail.com can't belong to an organisation.",
      ),
    ).toBeTruthy();
    expect(api.current!.writes()).toHaveLength(0);
    type(domains, 'old.qa');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(/belongs to an archived organisation/)).toBeTruthy();
    expect(api.current!.writes()[0]?.body).toEqual({
      emailDomains: ['old.qa'],
      expectedUpdatedAt: STAMP,
    });
  });

  it('manages sites: add, archive, restore and reorder with the keyboard', async () => {
    api.current!.on(`POST /admin/clients/${HMC}/sites`, (call) => ({
      item: site('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', HMC, (call.body as { name: string }).name),
    }));
    api.current!.on(`POST /admin/clients/${HMC}/sites/${LAB}/archive`, () => ({
      item: { ...orgs[0]!.sites[1]!, isActive: false },
    }));
    api.current!.on(`POST /admin/clients/${HMC}/sites/${GONE}/restore`, () => ({
      item: { ...orgs[0]!.sites[2]!, isActive: true },
    }));
    api.current!.on(`POST /admin/clients/${HMC}/sites/reorder`, () => undefined);
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('Hamad Medical');
    const list = within(dialog).getByRole('list', { name: 'Sites of Hamad Medical' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('Head Office'), expect.stringContaining('Lab')]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add site' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save site' }));
    expect(await within(dialog).findByText('This field is required.')).toBeTruthy();
    type(within(dialog).getByRole('textbox', { name: 'Site name English' }), 'Branch');
    type(within(dialog).getByRole('textbox', { name: 'Address' }), 'Al Sadd');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save site' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
    expect(api.current!.writes()[0]?.body).toEqual({
      name: 'Branch',
      nameAr: '',
      address: 'Al Sadd',
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Move Head Office down' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(2));
    expect(api.current!.writes()[1]?.body).toEqual({ ids: [LAB, HQ], expectedIds: [HQ, LAB] });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive Lab' }));
    await waitFor(() => expect(api.current!.writes()).toHaveLength(3));
    expect(api.current!.writes()[2]).toMatchObject({
      path: `/admin/clients/${HMC}/sites/${LAB}/archive`,
      body: { expectedUpdatedAt: STAMP },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Old Annex' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Old Annex restored'));
  });

  it('keeps keyboard focus in the sites list: editor, Escape, archive', async () => {
    api.current!.on(`POST /admin/clients/${HMC}/sites/${HQ}/archive`, () => {
      const archived = { ...orgs[0]!.sites[0]!, isActive: false };
      orgs = [{ ...orgs[0]!, sites: [archived, ...orgs[0]!.sites.slice(1)] }, ...orgs.slice(1)];
      return { item: archived };
    });
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('Hamad Medical');
    const add = within(dialog).getByRole('button', { name: 'Add site' });
    fireEvent.click(add);
    const name = within(dialog).getByRole('textbox', { name: 'Site name English' });
    await waitFor(() => expect(document.activeElement).toBe(name));
    type(name, 'Branch');
    // Escape cancels the site editor only; focus goes back to Add site.
    fireEvent.keyDown(name, { key: 'Escape' });
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Add site' })),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(api.current!.writes()).toHaveLength(0);

    // Archiving Head Office moves focus to the next site's Archive button.
    const archive = within(dialog).getByRole('button', { name: 'Archive Head Office' });
    archive.focus();
    fireEvent.click(archive);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Archive Lab' }),
      ),
    );
  });

  it('archives an organisation after confirming', async () => {
    api.current!.on(`POST /admin/clients/${QNB}/archive`, () => ({
      item: { ...orgs[1]!, isActive: false },
    }));
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
    const dialog = await openOrg('QNB');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Archive QNB?' });
    expect(within(confirm).getByText(/can still read their tickets/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('QNB archived'));
  });

  describe('pending sign-ups', () => {
    it('approves a sign-up into an organisation', async () => {
      api.current!.on(`POST /admin/clients/pending-signups/${PAT}/approve`, () => ({
        item: { ...pending[0]!, status: 'ACTIVE', org: { id: HMC, name: 'Hamad Medical' } },
      }));
      renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Pending sign-ups (1)' }));
      const pendingTable = await screen.findByRole('table', { name: 'Pending sign-ups' });
      expect(within(pendingTable).getByText('Unknown Co')).toBeTruthy();
      fireEvent.click(within(pendingTable).getByRole('button', { name: 'Pat Pending' }));
      const dialog = await screen.findByRole('dialog', { name: 'Review Pat Pending' });
      expect(within(dialog).getByText('Company they typed: Unknown Co')).toBeTruthy();
      await pick(within(dialog).getByRole('combobox', { name: 'Organisation' }), 'Hamad Medical');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
      expect(api.current!.writes()[0]?.body).toEqual({ orgId: HMC, expectedUpdatedAt: STAMP });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pat Pending approved'));
    });

    it('keeps showing an organisation picked through search, beyond the first page', async () => {
      const ZETA = '99999999-9999-4999-8999-999999999999';
      orgs = [
        ...Array.from({ length: 20 }, (_, i) =>
          org(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, `Alpha ${i + 1}`),
        ),
        org(ZETA, 'Zeta Hospital'),
      ];
      api.current!.on('GET /admin/clients', (call) => {
        const search = call.query.get('search')?.toLowerCase();
        const limit = Number(call.query.get('limit') ?? 50);
        const items = orgs.filter(
          (o) => o.isActive && (!search || o.name.toLowerCase().includes(search)),
        );
        return { items: items.slice(0, limit), nextCursor: null };
      });
      api.current!.on(`POST /admin/clients/pending-signups/${PAT}/approve`, () => ({
        item: { ...pending[0]!, status: 'ACTIVE', org: { id: ZETA, name: 'Zeta Hospital' } },
      }));
      renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Pending sign-ups (1)' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pat Pending' }));
      const dialog = await screen.findByRole('dialog', { name: 'Review Pat Pending' });
      const trigger = within(dialog).getByRole('combobox', { name: 'Organisation' });
      fireEvent.click(trigger);
      type(await screen.findByPlaceholderText('Search organisations'), 'zeta');
      fireEvent.click(await screen.findByRole('option', { name: /^Zeta Hospital/ }));
      await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      // The picker went back to the first page of organisations, which doesn't include Zeta.
      await waitFor(() =>
        expect(
          api.current!.calls.filter((c) => c.path === '/admin/clients' && !c.query.get('search')),
        ).not.toHaveLength(0),
      );
      await settle();
      expect(trigger.textContent).toBe('Zeta Hospital');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
      expect(api.current!.writes()[0]?.body).toEqual({ orgId: ZETA, expectedUpdatedAt: STAMP });
    });

    it('lists rejected sign-ups on request: one can still be approved, not rejected again', async () => {
      const REX = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const rex: PendingSignupDto = {
        ...pending[0]!,
        id: REX,
        name: 'Rex Roe',
        email: 'rex@unknown.example',
        signupCompany: null,
        status: 'DISABLED',
      };
      api.current!.on('GET /admin/clients/pending-signups', (call) => ({
        items: call.query.get('status') === 'rejected' ? [rex] : pending,
        nextCursor: null,
      }));
      api.current!.on(`POST /admin/clients/pending-signups/${REX}/approve`, () => ({
        item: { ...rex, status: 'ACTIVE', org: { id: HMC, name: 'Hamad Medical' } },
      }));
      renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Pending sign-ups (1)' }));
      const pendingTable = await screen.findByRole('table', { name: 'Pending sign-ups' });
      await within(pendingTable).findByRole('button', { name: 'Pat Pending' });
      expect(within(pendingTable).queryByText('Rex Roe')).toBeNull();
      fireEvent.click(screen.getByRole('switch', { name: 'Show rejected sign-ups' }));
      const row = await within(pendingTable).findByRole('button', { name: /^Rex Roe/ });
      expect(within(row).getByText('Rejected')).toBeTruthy();
      // The tab counts the sign-ups waiting for a decision only.
      expect(screen.getByRole('tab', { name: 'Pending sign-ups (1)' })).toBeTruthy();
      fireEvent.click(row);
      const dialog = await screen.findByRole('dialog', { name: 'Review Rex Roe' });
      expect(
        within(dialog).getByText(
          'This sign-up was rejected and the account is disabled. Approving it into an organisation restores it.',
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Reject' })).toBeNull();
      await pick(within(dialog).getByRole('combobox', { name: 'Organisation' }), 'Hamad Medical');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(api.current!.writes()).toHaveLength(1));
      expect(api.current!.writes()[0]).toMatchObject({
        path: `/admin/clients/pending-signups/${REX}/approve`,
        body: { orgId: HMC, expectedUpdatedAt: STAMP },
      });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Rex Roe approved'));
    });

    it('rejects after confirming; an already-handled sign-up is explained', async () => {
      let first = true;
      api.current!.on(`POST /admin/clients/pending-signups/${PAT}/reject`, () => {
        if (first) {
          first = false;
          throw conflict({ reason: 'guard', guard: 'signup_not_pending' });
        }
        return { item: { ...pending[0]!, status: 'DISABLED' } };
      });
      renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Pending sign-ups (1)' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pat Pending' }));
      const dialog = await screen.findByRole('dialog', { name: 'Review Pat Pending' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Reject Pat Pending?' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Reject' }));
      expect(
        await within(dialog).findByText('This sign-up was already approved or rejected.'),
      ).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
      fireEvent.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reject' }),
      );
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Pat Pending rejected'));
    });
  });

  it('renders in Arabic', async () => {
    renderSection(<ClientsSection role="SUPER_ADMIN" userId={MAYA} />, 'ar');
    const arTable = await screen.findByRole('table', { name: 'العملاء والمواقع' });
    expect(await within(arTable).findByText('مؤسسة حمد الطبية')).toBeTruthy();
    expect(within(arTable).getByText('عقد صيانة')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'الجهات' })).toBeTruthy();
  });
});
