// @vitest-environment jsdom
import type { AuditLogEntryDto } from '@loons/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { choose, clone, renderComms, stubBrowserApis } from '../email-templates/comms-test-utils';
import arComms from '@/messages/ar/admin-comms.json';
import { auditTimeZone, endOfDayExclusive, fieldChanges, startOfDay } from './audit-format';
import AuditLogSection, { auditQueryParams } from '.';

// Audit log viewer (E17): newest first, readable before / after, filters (record type, action,
// person from /admin/audit-log/actors, dates as whole days in the business time zone — Qatar
// unless General settings say otherwise — one record's history), "Load older entries" with the
// cursor, read-only — against an in-memory /admin/audit-log.

const api = vi.hoisted(() => ({
  gets: [] as URL[],
  entries: [] as AuditLogEntryDto[],
  pageSize: 3,
  /** General settings' business time zone. */
  timeZone: 'Asia/Qatar',
}));

vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      const url = new URL(path, 'http://api.test');
      api.gets.push(url);
      if (url.pathname === '/admin/audit-log/actors') {
        // Everyone with entries, by name — whatever their status or role is now.
        const person = (id: string, name: string, role: string, status = 'ACTIVE') => ({
          id,
          name,
          role,
          status,
        });
        return {
          items: [
            person(ID.dan, 'Dan Demoted', 'AGENT'),
            person(ID.dora, 'Dora Former', 'SUPER_ADMIN', 'DISABLED'),
            person(ID.sam, 'Sam Admin', 'SUPER_ADMIN'),
            person(ID.tia, 'Tia Lead', 'TEAM_LEAD'),
          ],
        };
      }
      if (url.pathname === '/admin/settings') {
        return {
          values: {
            businessTimezone: api.timeZone,
            socPhone: null,
            autoCloseDays: 7,
            p4DigestTime: '08:00',
            securityCategoryKey: 'security',
          },
          updatedAt: null,
        };
      }
      const q = url.searchParams;
      let items = api.entries.filter(
        (e) =>
          (!q.get('entity') || e.entity === q.get('entity')) &&
          (!q.get('entityId') || e.entityId === q.get('entityId')) &&
          (!q.get('action') || e.action === q.get('action')) &&
          (!q.get('actorId') || e.actor?.id === q.get('actorId')),
      );
      const cursor = q.get('cursor');
      if (cursor) items = items.slice(items.findIndex((e) => e.id === cursor) + 1);
      const page = items.slice(0, api.pageSize);
      return {
        items: clone(page),
        nextCursor: items.length > api.pageSize ? page.at(-1)!.id : null,
      };
    }),
  },
}));

const ID = {
  sam: '00000000-0000-4000-8000-000000000001',
  tia: '00000000-0000-4000-8000-000000000002',
  ali: '00000000-0000-4000-8000-000000000003',
  dora: '00000000-0000-4000-8000-000000000004',
  dan: '00000000-0000-4000-8000-000000000005',
  team: '00000000-0000-4000-8000-000000000100',
};

function entry(n: number, overrides: Partial<AuditLogEntryDto> = {}): AuditLogEntryDto {
  return {
    id: `00000000-0000-4000-8000-00000000${String(1000 + n)}`,
    actor: { id: ID.sam, name: 'Sam Admin', role: 'SUPER_ADMIN' },
    action: 'UPDATE',
    entity: 'Team',
    entityId: ID.team,
    entityLabel: 'SOC',
    requestId: `req-${n}`,
    before: { nameEn: 'SOC', isActive: true },
    after: { nameEn: 'Security Operations', isActive: false },
    createdAt: new Date(Date.UTC(2026, 8, 29, 9, 60 - n)).toISOString(),
    ...overrides,
  };
}

// Multi-step sheet flows: allow for a loaded machine (full suites; the default is 5 s).
vi.setConfig({ testTimeout: 20_000 });
beforeAll(stubBrowserApis);
beforeEach(() => {
  api.gets = [];
  api.pageSize = 3;
  api.timeZone = 'Asia/Qatar';
  api.entries = [
    entry(1),
    entry(2, {
      action: 'CREATE',
      entity: 'HelpArticle',
      entityId: 'a-1',
      entityLabel: 'How do I report an incident?',
      before: null,
      after: { key: 'report', titleAr: '', isPublished: false },
      actor: { id: ID.tia, name: 'Tia Lead', role: 'TEAM_LEAD' },
    }),
    entry(3, {
      action: 'REORDER',
      entity: 'HelpArticle',
      entityId: 'help-center',
      entityLabel: 'Help center',
      before: { order: ['a', 'b'] },
      after: { order: ['b', 'a'] },
      actor: null,
    }),
    entry(4, {
      action: 'UPDATE',
      entity: 'Team',
      before: { teamsWebhookHost: null, emails: ['a@x.test'] },
      after: { teamsWebhookHost: 'contoso.webhook.office.com', emails: [] },
    }),
    entry(5, { action: 'ARCHIVE', entity: 'Category', entityId: 'c-1', entityLabel: 'CCTV' }),
  ];
});
afterEach(cleanup);

const logGets = () => api.gets.filter((u) => u.pathname === '/admin/audit-log');

function renderSection(locale: 'en' | 'ar' = 'en') {
  return renderComms(<AuditLogSection role="SUPER_ADMIN" userId={ID.sam} />, { locale });
}

async function rows() {
  const table = await screen.findByRole('table', { name: /Audit log entries|سجل التدقيق/ });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
  return within(table).getAllByRole('row').slice(1);
}

describe('audit helpers', () => {
  it('turns whole days into Qatar-time instants (to is inclusive of the day)', () => {
    expect(startOfDay('2026-09-01')).toBe('2026-08-31T21:00:00.000Z');
    expect(endOfDayExclusive('2026-09-01')).toBe('2026-09-01T21:00:00.000Z');
    expect(endOfDayExclusive('2026-12-31')).toBe('2026-12-31T21:00:00.000Z');
    expect(startOfDay('2026-09-01', 'UTC')).toBe('2026-09-01T00:00:00.000Z');
    expect(startOfDay('yesterday')).toBeNull();
    expect(
      auditQueryParams({
        entity: 'Team',
        action: '',
        actorId: '',
        from: '2026-09-01',
        to: '2026-09-02',
        entityId: '',
      }),
    ).toEqual({
      entity: 'Team',
      action: undefined,
      actorId: undefined,
      entityId: undefined,
      from: '2026-08-31T21:00:00.000Z',
      to: '2026-09-02T21:00:00.000Z',
    });
  });

  it('uses the configured time zone when this browser knows it', () => {
    expect(auditTimeZone('Europe/London')).toBe('Europe/London');
    expect(auditTimeZone(undefined)).toBe('Asia/Qatar');
    expect(auditTimeZone('Not/AZone')).toBe('Asia/Qatar');
  });

  it('lists the changed fields of both sides', () => {
    expect(fieldChanges({ before: null, after: { a: 1 } })).toEqual([
      { field: 'a', before: undefined, after: 1, hasBefore: false, hasAfter: true },
    ]);
    expect(fieldChanges({ before: { a: 1, b: 2 }, after: { a: 3 } }).map((c) => c.field)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('AuditLogSection', () => {
  it('lists entries newest first: when, who, action, record and how many fields changed', async () => {
    renderSection();
    const list = await rows();
    expect(list).toHaveLength(3);
    expect(list[0]!.textContent).toContain('Sam Admin');
    expect(list[0]!.textContent).toContain('Updated');
    expect(list[0]!.textContent).toContain('Team');
    expect(list[0]!.textContent).toContain('2 fields');
    expect(list[1]!.textContent).toContain('Created');
    expect(list[1]!.textContent).toContain('How do I report an incident?');
    expect(list[2]!.textContent).toContain('Deleted account or system');
    expect(screen.getByText(/Read-only: entries can’t be changed or deleted/)).toBeTruthy();
    expect(screen.getByText('Only Super Admins can open this section.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create new' })).toBeNull();
  });

  it('loads older entries with the cursor until the start of the log', async () => {
    renderSection();
    await rows();
    fireEvent.click(screen.getByRole('button', { name: 'Load older entries' }));
    await waitFor(async () => expect(await rows()).toHaveLength(5));
    expect(logGets().at(-1)?.searchParams.get('cursor')).toBe(api.entries[2]!.id);
    expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
  });

  it('filters by record type, action, person and dates, and clears the filters', async () => {
    renderSection();
    await rows();
    await choose(screen.getByRole('combobox', { name: /Record type/ }), 'Help article');
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('entity')).toBe('HelpArticle'));
    await waitFor(async () => expect(await rows()).toHaveLength(2));

    await choose(screen.getByRole('combobox', { name: /^Action/ }), 'Reordered');
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('action')).toBe('REORDER'));

    // Everyone who has entries (GET /admin/audit-log/actors), disabled or demoted people too.
    const actor = screen.getByRole('combobox', { name: /Changed by/ });
    act(() => actor.focus());
    fireEvent.keyDown(actor, { key: 'Enter' });
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Anyone', 'Dan Demoted', 'Dora Former (disabled)', 'Sam Admin', 'Tia Lead']);
    expect(api.gets.some((u) => u.pathname === '/admin/staff-directory')).toBe(false);
    fireEvent.keyDown(within(listbox).getByRole('option', { name: 'Tia Lead' }), { key: 'Enter' });
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('actorId')).toBe(ID.tia));

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-29' } });
    await waitFor(() => {
      const q = logGets().at(-1)!.searchParams;
      expect(q.get('from')).toBe('2026-08-31T21:00:00.000Z');
      expect(q.get('to')).toBe('2026-09-29T21:00:00.000Z');
    });
    expect(await screen.findByText('No entries match')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(async () => expect(await rows()).toHaveLength(3));
    expect(screen.getByRole('combobox', { name: /Record type/ }).textContent).toBe(
      'All record types',
    );
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('shows an entry read-only with its fields before and after, and a record’s history', async () => {
    renderSection();
    await rows();
    fireEvent.click(screen.getAllByRole('button', { name: /Updated · Team · SOC/ })[0]!);
    const sheet = await screen.findByRole('dialog', { name: 'Updated · Team' });
    expect(within(sheet).queryByRole('button', { name: 'Save' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Archive' })).toBeNull();
    // Nothing to cancel: the footer offers Close.
    expect(within(sheet).queryByRole('button', { name: 'Cancel' })).toBeNull();
    const footer = sheet.querySelector<HTMLElement>('[data-slot="sheet-footer"]')!;
    expect(within(footer).getByRole('button', { name: 'Close' })).toBeTruthy();
    const table = within(sheet).getByRole('table');
    const nameRow = within(table).getByRole('row', { name: /nameEn/ });
    expect(nameRow.textContent).toContain('SOC');
    expect(nameRow.textContent).toContain('Security Operations');
    const activeRow = within(table).getByRole('row', { name: /isActive/ });
    expect(within(activeRow).getByText('Yes')).toBeTruthy();
    expect(within(activeRow).getByText('No')).toBeTruthy();
    expect(within(sheet).getByText('req-1')).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Show this record’s history' }));
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('entityId')).toBe(ID.team));
    expect(logGets().at(-1)?.searchParams.get('entity')).toBe('Team');
    expect(await screen.findByText(`Only record \u2066${ID.team}\u2069`)).toBeTruthy();
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Show every record' }));
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('entityId')).toBeNull());
  });

  // Review web-comms-1 / contract-8.
  it('filters by an admin who has since been disabled', async () => {
    api.entries.push(
      entry(6, { actor: { id: ID.dora, name: 'Dora Former', role: 'SUPER_ADMIN' } }),
    );
    renderSection();
    await rows();
    await choose(screen.getByRole('combobox', { name: /Changed by/ }), 'Dora Former (disabled)');
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('actorId')).toBe(ID.dora));
    await waitFor(async () => expect(await rows()).toHaveLength(1));
  });

  // Review web-comms-4: an id whose first group is all digits reorders inside an Arabic sentence.
  it('isolates the record id in the “only this record” badge (Arabic)', async () => {
    const id = '12345678-1a34-4234-8234-123456789012';
    api.entries = [entry(1, { entityId: id })];
    renderSection('ar');
    await rows();
    fireEvent.click(screen.getAllByRole('button', { name: /تعديل/ })[0]!);
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: arComms.auditLog.detail.onlyThis }));
    await waitFor(() => expect(logGets().at(-1)?.searchParams.get('entityId')).toBe(id));
    expect(
      await screen.findByText(`السجل \u2066${id}\u2069 فقط`, { normalizer: (text) => text }),
    ).toBeTruthy();
  });

  // Review web-comms-5: the business time zone is editable (E11); the viewer follows it.
  it('uses the configured business time zone for the day filters and the times', async () => {
    api.timeZone = 'Europe/London';
    renderSection();
    expect(await screen.findByText('Days and times are in Europe/London time.')).toBeTruthy();
    // 09:59 UTC is 10:59 in London in September (12:59 in Qatar).
    await waitFor(async () => expect((await rows())[0]!.textContent).toContain('10:59'));
    // The entry sheet shows the same zone as the rows.
    fireEvent.click(within((await rows())[0]!).getAllByRole('button')[0]!);
    const sheet = await screen.findByRole('dialog');
    expect(sheet.textContent).toContain('10:59');
    expect(sheet.textContent).not.toContain('12:59');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    await waitFor(() => {
      const q = logGets().at(-1)!.searchParams;
      expect(q.get('from')).toBe('2026-09-29T23:00:00.000Z');
      expect(q.get('to')).toBe('2026-09-30T23:00:00.000Z');
    });
  });

  it('renders lists, empty values and a create without a before side', async () => {
    renderSection();
    await rows();
    fireEvent.click(screen.getByRole('button', { name: /Created/ }));
    const created = await screen.findByRole('dialog', { name: 'Created · Help article' });
    const titleAr = within(within(created).getByRole('table')).getByRole('row', {
      name: /titleAr/,
    });
    expect(within(titleAr).getAllByText('(empty)')).toHaveLength(2);
    fireEvent.keyDown(created, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: /Reordered/ }));
    const reordered = await screen.findByRole('dialog', { name: 'Reordered · Help article' });
    const order = within(within(reordered).getByRole('table')).getByRole('row', { name: /order/ });
    expect(within(order).getAllByRole('list')).toHaveLength(2);
    expect(
      within(order)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a', 'b', 'b', 'a']);
  });

  it('shows the empty state', async () => {
    api.entries = [];
    renderSection();
    expect(await screen.findByText('No changes recorded yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
  });

  it('works in Arabic', async () => {
    renderSection('ar');
    const list = await rows();
    expect(screen.getByRole('table', { name: 'سجل التدقيق' })).toBeTruthy();
    expect(list[0]!.textContent).toContain('تعديل');
    expect(list[0]!.textContent).toContain('فريق');
    expect(list[0]!.textContent).toContain('حقلان');
    expect(screen.getByRole('combobox', { name: /نوع السجل/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تحميل إدخالات أقدم' })).toBeTruthy();
  });

  it('isolates an English record label in the Arabic entry sheet', async () => {
    renderSection('ar');
    const list = await rows();
    fireEvent.click(within(list[0]!).getAllByRole('button')[0]!);
    const sheet = await screen.findByRole('dialog');
    // FSI … PDI around the label, so the date after it keeps its place.
    expect(sheet.textContent).toContain('⁨SOC⁩');
  });
});
