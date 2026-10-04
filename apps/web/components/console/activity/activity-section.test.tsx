// @vitest-environment jsdom
import type { TicketEventDto, TicketEventList, TicketEventType } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { RealtimeClient } from '@/lib/realtime/client';
import { fakeSocketFactory, type FakeSocket } from '@/lib/realtime/fake-socket';
import { RealtimeProvider } from '@/lib/realtime/provider';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { IDS, TEAMS, fixtureId, makeSummary } from '@/lib/tickets/test-fixtures';
import type { Viewer } from '@/lib/tickets/types';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import { ActivitySection } from './activity-section';
import { ACTIVITY_REFRESH_DEBOUNCE_MS } from './use-ticket-events';

// The staff activity timeline in the console ticket panel (docs/PHASE5_CONTRACT.md F14): collapsed
// until opened, one line per event (what, who, when), labels resolved (archived / disabled /
// deleted), newest first with "Show older activity", refetched on `ticket:updated` for the ticket
// and whenever the section opens; never rendered for clients.

const api = vi.hoisted(() => ({
  calls: [] as string[],
  /** Answers GET /tickets/:id/events by cursor ('' = first page). */
  pages: new Map<string, TicketEventList | Error>(),
}));
vi.mock('@/lib/api/browser', () => ({
  apiClient: {
    get: vi.fn(async (path: string) => {
      api.calls.push(path);
      const url = new URL(path, 'http://api.test');
      const answer = api.pages.get(url.searchParams.get('cursor') ?? '');
      if (!answer) throw new ApiRequestError(404, 'NOT_FOUND', 'not in this test');
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  },
  getApiToken: vi.fn(async () => 'token'),
  clearApiToken: vi.fn(),
}));

const holder = vi.hoisted(() => ({ client: null as RealtimeClient | null }));
vi.mock('@/lib/realtime/client', async (importOriginal) => ({
  ...(await importOriginal()),
  getRealtimeClient: () => holder.client,
}));

const NOW = new Date('2026-09-23T12:07:00.000Z');
const MESSAGES = {
  en: { common: enCommon, console: enConsole, errors: enErrors, tickets: enTickets },
  ar: { common: arCommon, console: arConsole, errors: arErrors, tickets: arTickets },
};
const STAFF: Viewer = { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' };
const CLIENT: Viewer = { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', role: 'CLIENT' };
const MAYA = { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' as const };
const RAMI = { kind: 'user' as const, id: fixtureId(811), name: 'Rami Member', isActive: true };

/** Strips the bidi isolation marks around inserted values. */
const plain = (text: string | null | undefined) => (text ?? '').replace(/[⁦-⁩]/g, '');
const eventsPath = (cursor?: string) =>
  `/tickets/${IDS.ticket}/events?${cursor ? `cursor=${cursor}&` : ''}limit=20`;

let seq = 0;
function ev(type: TicketEventType, overrides: Partial<TicketEventDto> = {}): TicketEventDto {
  seq += 1;
  return {
    id: fixtureId(3000 + seq),
    type,
    actor: MAYA,
    from: null,
    to: null,
    meta: {},
    createdAt: '2026-09-23T12:00:00.000Z',
    ...overrides,
  };
}

let fake: ReturnType<typeof fakeSocketFactory>;
let socket: FakeSocket;

beforeEach(() => {
  api.calls = [];
  api.pages.clear();
  fake = fakeSocketFactory();
  holder.client = new RealtimeClient({
    url: 'http://api.test',
    getToken: async () => 'token',
    createSocket: fake.factory,
    idleCloseMs: 10,
  });
});
afterEach(cleanup);

function renderActivity(
  options: { locale?: 'en' | 'ar'; viewer?: Viewer; queryClient?: QueryClient } = {},
) {
  const { locale = 'en', viewer = STAFF } = options;
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        now={NOW}
        messages={MESSAGES[locale]}
      >
        <ViewerProvider viewer={viewer}>
          <RealtimeProvider>
            <ActivitySection ticketId={IDS.ticket} />
          </RealtimeProvider>
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  // The provider opened the connection on mount: the live socket is the last one.
  socket = fake.sockets[fake.sockets.length - 1]!;
  act(() => socket.accept());
  return { ...utils, queryClient };
}

const toggle = (name = 'Activity') => screen.getByRole('button', { name });
const items = () => [...document.querySelectorAll<HTMLElement>('[data-event]')];
const lines = () => items().map((li) => plain(li.querySelector('p')?.textContent));

async function openSection(name?: string) {
  fireEvent.click(toggle(name));
  await waitFor(() => expect(items().length).toBeGreaterThan(0));
}

describe('ActivitySection', () => {
  it('is collapsed (and loads nothing) until opened, then shows skeletons and the events', async () => {
    api.pages.set('', { items: [ev('CREATED', { meta: { priority: 'P1' } })], nextCursor: null });
    renderActivity();
    const button = toggle();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { level: 3, name: 'Activity' })).toBeTruthy();
    expect(document.getElementById(button.getAttribute('aria-controls')!)?.hidden).toBe(true);
    expect(api.calls).toEqual([]);

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Loading activity…');
    await waitFor(() => expect(lines()).toEqual(['Ticket created as P1 Critical']));
    expect(api.calls).toEqual([eventsPath()]);
    expect(screen.getByRole('list', { name: 'Ticket activity, newest first' })).toBeTruthy();

    // Who and when: the relative time, the absolute one (Doha time) in the tooltip.
    const meta = items()[0]!.querySelectorAll('p')[1]!;
    expect(plain(meta.textContent)).toBe(
      `Maya Ruiz · ${formatRelativeTime('2026-09-23T12:00:00.000Z', 'en', NOW.getTime())}`,
    );
    const time = meta.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe('2026-09-23T12:00:00.000Z');
    expect(time.getAttribute('title')).toBe(formatDateTime('2026-09-23T12:00:00.000Z', 'en'));
    expect(time.getAttribute('title')).toBe('Sep 23, 15:00');
  });

  it('says what each kind of event changed, with archived, disabled and deleted values marked', async () => {
    const cases: [TicketEventDto, string][] = [
      [ev('CREATED'), 'Ticket created'],
      [
        ev('STATUS_CHANGED', {
          from: { kind: 'status', value: 'OPEN' },
          to: { kind: 'status', value: 'PENDING' },
        }),
        'Status changed from Open to Pending',
      ],
      [ev('REOPENED', { to: { kind: 'status', value: 'OPEN' } }), 'Ticket reopened'],
      [
        ev('PRIORITY_CHANGED', {
          from: { kind: 'priority', value: 'P2' },
          to: { kind: 'priority', value: 'P1' },
        }),
        'Priority changed from P2 High to P1 Critical',
      ],
      [
        ev('IMPACT_CHANGED', {
          from: { kind: 'impact', value: 'SINGLE_USER' },
          to: { kind: 'impact', value: 'ENTIRE_SITE' },
        }),
        'Impact changed from Single user to Entire site',
      ],
      [ev('ASSIGNEE_CHANGED', { to: RAMI }), 'Assigned to Rami Member'],
      // The system picked the assignee from the category's skills (no actor).
      [
        ev('ASSIGNEE_CHANGED', { actor: null, to: RAMI, meta: { auto: true } }),
        'Automatically assigned to Rami Member (matched by skill)',
      ],
      // `auto` only words a first assignment: a hand-over keeps the plain sentence.
      [
        ev('ASSIGNEE_CHANGED', {
          from: { ...RAMI, name: 'Maya Ruiz', id: IDS.staff },
          to: RAMI,
          meta: { auto: true },
        }),
        'Reassigned from Maya Ruiz to Rami Member',
      ],
      [
        ev('ASSIGNEE_CHANGED', { from: { ...RAMI, name: 'Maya Ruiz', id: IDS.staff }, to: RAMI }),
        'Reassigned from Maya Ruiz to Rami Member',
      ],
      [ev('ASSIGNEE_CHANGED', { from: RAMI }), 'Unassigned (was Rami Member)'],
      [
        ev('ASSIGNEE_CHANGED', { to: { ...RAMI, name: 'Theo Kim', isActive: false } }),
        'Assigned to Theo Kim (disabled)',
      ],
      [
        ev('ASSIGNEE_CHANGED', {
          from: { kind: 'removed', entity: 'user', id: fixtureId(899) },
          to: RAMI,
        }),
        'Reassigned from a deleted user to Rami Member',
      ],
      [
        ev('TEAM_CHANGED', {
          from: { kind: 'team', ...TEAMS.triage, isActive: false },
          to: { kind: 'team', ...TEAMS.soc, isActive: true },
        }),
        'Team changed from Triage (archived) to SOC',
      ],
      [
        ev('TEAM_CHANGED', {
          from: { kind: 'team', ...TEAMS.soc, isActive: true },
          to: { kind: 'removed', entity: 'team', id: fixtureId(199) },
        }),
        'Team changed from SOC to a deleted team',
      ],
      [
        ev('CATEGORY_CHANGED', {
          from: {
            kind: 'category',
            id: IDS.other,
            key: 'other',
            labelEn: 'Other',
            labelAr: 'أخرى',
            icon: 'circle-question-mark',
            isActive: false,
          },
          to: {
            kind: 'category',
            id: IDS.cyber,
            key: 'cyber',
            labelEn: 'Cybersecurity / SOC',
            labelAr: 'الأمن السيبراني / SOC',
            icon: 'shield',
            isActive: true,
          },
        }),
        'Category changed from Other (archived) to Cybersecurity / SOC',
      ],
      [
        ev('SUBTYPE_CHANGED', {
          to: {
            kind: 'subtype',
            id: IDS.phishing,
            key: 'phishing',
            labelEn: 'Phishing report',
            labelAr: 'بلاغ تصيد احتيالي',
            isActive: true,
          },
        }),
        'Sub-type set to Phishing report',
      ],
      [
        ev('SUBTYPE_CHANGED', {
          from: { kind: 'removed', entity: 'subtype', id: fixtureId(398) },
          to: {
            kind: 'subtype',
            id: IDS.phishing,
            key: 'phishing',
            labelEn: 'Phishing report',
            labelAr: '',
            isActive: true,
          },
        }),
        'Sub-type changed from a deleted sub-type to Phishing report',
      ],
      [
        ev('SITE_CHANGED', {
          from: {
            kind: 'site',
            id: IDS.siteA,
            name: 'HMC – Building 3, Level 2',
            nameAr: null,
            isActive: false,
          },
          to: {
            kind: 'site',
            id: IDS.siteB,
            name: 'HMC – Main Data Center',
            nameAr: 'مؤسسة حمد – مركز البيانات',
            isActive: true,
          },
        }),
        'Site changed from HMC – Building 3, Level 2 (archived) to HMC – Main Data Center',
      ],
      [
        ev('ASSET_CHANGED', { from: { kind: 'text', value: 'NVR-01' } }),
        'Asset ID cleared (was NVR-01)',
      ],
      [
        ev('ASSET_CHANGED', {
          from: { kind: 'text', value: 'NVR-01' },
          to: { kind: 'text', value: 'NVR-02' },
        }),
        'Asset ID changed from NVR-01 to NVR-02',
      ],
      [
        ev('TYPE_CHANGED', {
          from: { kind: 'text', value: 'INCIDENT' },
          to: { kind: 'text', value: 'SERVICE_REQUEST' },
        }),
        'Ticket type changed from Incident to Service Request',
      ],
      [
        ev('TAGS_CHANGED', {
          from: { kind: 'tags', value: ['cctv'] },
          to: { kind: 'tags', value: ['vpn'] },
          meta: { added: ['vpn'], removed: ['cctv'] },
        }),
        'Tags added: vpn; removed: cctv',
      ],
      [
        ev('TAGS_CHANGED', {
          from: { kind: 'tags', value: ['a'] },
          to: { kind: 'tags', value: ['a', 'b', 'c'] },
        }),
        'Tags added: b and c',
      ],
      [
        ev('TAGS_CHANGED', {
          from: { kind: 'tags', value: ['a'] },
          to: { kind: 'tags', value: [] },
        }),
        'Tags removed: a',
      ],
      [
        ev('CUSTOM_FIELDS_CHANGED', {
          meta: {
            fields: [
              { key: 'camera_id', labelEn: 'Camera ID', labelAr: 'رقم الكاميرا', isActive: true },
              { key: 'old', labelEn: 'Legacy', labelAr: '', isActive: false },
            ],
          },
        }),
        'Custom fields changed: Camera ID and Legacy (archived)',
      ],
      [ev('CUSTOM_FIELDS_CHANGED'), 'Custom fields changed'],
      [ev('FIRST_REPLY', { meta: { minutesToFirstReply: 12 } }), 'First reply sent after 12m'],
      [ev('FIRST_REPLY'), 'First reply sent'],
      [
        ev('SLA_AT_RISK', {
          actor: null,
          meta: { target: 'FIRST_REPLY', dueAt: '2026-09-23T12:15:00.000Z' },
        }),
        'First-reply SLA at risk',
      ],
      [
        ev('SLA_BREACHED', { actor: null, meta: { target: 'RESOLUTION' } }),
        'Resolution SLA breached',
      ],
      [ev('SLA_BREACHED', { actor: null }), 'SLA breached'],
      [
        ev('ESCALATED', {
          actor: null,
          from: { kind: 'step', value: 1 },
          to: { kind: 'step', value: 2 },
          meta: { step: 2, targetType: 'ROLE', channels: ['EMAIL', 'SMS'] },
        }),
        'P1 escalated to step 2',
      ],
      [
        ev('P1_ACKNOWLEDGED', {
          to: { kind: 'user', id: IDS.staff, name: 'Maya Ruiz', isActive: true },
          meta: { step: 1, minutesToAcknowledge: 7 },
        }),
        'P1 acknowledged after 7m',
      ],
      [ev('P1_ACKNOWLEDGED', { meta: { minutesToAcknowledge: null } }), 'P1 acknowledged'],
      [
        ev('AUTO_CLOSED', {
          actor: null,
          from: { kind: 'status', value: 'SOLVED' },
          to: { kind: 'status', value: 'CLOSED' },
          meta: { days: 5 },
        }),
        'Closed automatically 5 days after it was solved',
      ],
      [
        ev('AUTO_CLOSED', { actor: null, meta: { days: 1 } }),
        'Closed automatically 1 day after it was solved',
      ],
    ];
    api.pages.set('', { items: cases.map(([event]) => event), nextCursor: null });
    renderActivity();
    await openSection();
    expect(lines()).toEqual(cases.map(([, text]) => text));

    // The system's events say so; people's show their name.
    const who = (type: TicketEventType) =>
      plain(
        items()
          .find((li) => li.dataset.event === type)
          ?.querySelectorAll('p')[1]?.textContent,
      ).split(' · ')[0];
    expect(who('SLA_BREACHED')).toBe('System');
    const autoAssigned = items().find((li) => li.textContent?.includes('matched by skill'));
    expect(plain(autoAssigned?.querySelectorAll('p')[1]?.textContent).split(' · ')[0]).toBe(
      'System',
    );
    expect(who('ESCALATED')).toBe('System');
    expect(who('STATUS_CHANGED')).toBe('Maya Ruiz');
  });

  it('works in Arabic, isolating inserted values (labels by direction, step numbers left to right)', async () => {
    api.pages.set('', {
      items: [
        ev('PRIORITY_CHANGED', {
          from: { kind: 'priority', value: 'P2' },
          to: { kind: 'priority', value: 'P1' },
        }),
        ev('ESCALATED', { actor: null, to: { kind: 'step', value: 2 }, meta: { step: 2 } }),
        ev('ASSIGNEE_CHANGED', { actor: null, to: RAMI, meta: { auto: true } }),
        ev('AUTO_CLOSED', { actor: null, meta: { days: 5 } }),
        ev('TEAM_CHANGED', {
          from: { kind: 'team', ...TEAMS.triage, isActive: false },
          to: { kind: 'removed', entity: 'team', id: fixtureId(199) },
        }),
        // A category is feminine in Arabic: its "(archived)" marker agrees (UI gap G15).
        ev('CATEGORY_CHANGED', {
          from: {
            kind: 'category',
            id: IDS.other,
            key: 'other',
            labelEn: 'Other',
            labelAr: 'أخرى',
            icon: 'circle-question-mark',
            isActive: false,
          },
          to: {
            kind: 'category',
            id: IDS.cyber,
            key: 'cyber',
            labelEn: 'Cybersecurity / SOC',
            labelAr: 'الأمن السيبراني / SOC',
            icon: 'shield',
            isActive: true,
          },
        }),
        ev('SUBTYPE_CHANGED', {
          from: {
            kind: 'subtype',
            id: IDS.phishing,
            key: 'phishing',
            labelEn: 'Phishing report',
            labelAr: 'بلاغ تصيد احتيالي',
            isActive: false,
          },
        }),
      ],
      nextCursor: null,
    });
    renderActivity({ locale: 'ar' });
    await openSection('النشاط');
    expect(lines()).toEqual([
      'تغيير الأولوية من P2 عالية إلى P1 حرجة',
      'تم تصعيد P1 إلى المرحلة 2',
      'أُسندت تلقائيًا إلى Rami Member (بحسب المهارة)',
      'أُغلقت تلقائيًا بعد 5 أيام من حلّها',
      'تغيير الفريق من الفرز (مؤرشف) إلى فريق محذوف',
      'تغيير الفئة من أخرى (مؤرشفة) إلى الأمن السيبراني / SOC',
      'إزالة النوع الفرعي (السابق: بلاغ تصيد احتيالي (مؤرشف))',
    ]);
    const raw = items().map((li) => li.querySelector('p')?.textContent ?? '');
    // Catalogue labels ("P1 حرجة") in right-to-left isolates, so "P1" stays before its word.
    expect(raw[0]).toContain('⁧P1 حرجة⁩');
    // The step number in a left-to-right isolate (RTL-1).
    expect(raw[1]).toContain('⁦2⁩');
    expect(plain(items()[1]!.querySelectorAll('p')[1]!.textContent).split(' · ')[0]).toBe('النظام');
  });

  it('pages with "Show older activity" and moves the focus to the first older event', async () => {
    const newest = ev('PRIORITY_CHANGED', {
      from: { kind: 'priority', value: 'P2' },
      to: { kind: 'priority', value: 'P1' },
    });
    const oldest = ev('CREATED');
    api.pages.set('', { items: [newest], nextCursor: 'c1' });
    api.pages.set('c1', { items: [oldest], nextCursor: null });
    renderActivity();
    await openSection();
    expect(lines()).toEqual(['Priority changed from P2 High to P1 Critical']);

    const more = screen.getByRole('button', { name: 'Show older activity' });
    more.focus();
    fireEvent.click(more);
    await waitFor(() =>
      expect(lines()).toEqual(['Priority changed from P2 High to P1 Critical', 'Ticket created']),
    );
    expect(api.calls).toEqual([eventsPath(), eventsPath('c1')]);
    expect(screen.queryByRole('button', { name: 'Show older activity' })).toBeNull();
    expect(document.activeElement).toBe(items()[1]);
  });

  it('refetches (debounced) on ticket:updated for this ticket only, and shows the new events', async () => {
    api.pages.set('', { items: [ev('CREATED')], nextCursor: null });
    renderActivity();
    await openSection();
    expect(api.calls).toHaveLength(1);

    // Another ticket's update: nothing to do.
    act(() => socket.receive('ticket:updated', { ticket: makeSummary({ id: fixtureId(902) }) }));
    // A burst for this ticket (a step firing with its alerts): one refetch.
    api.pages.set('', {
      items: [ev('ESCALATED', { actor: null, to: { kind: 'step', value: 1 } }), ev('CREATED')],
      nextCursor: null,
    });
    act(() => {
      for (let i = 0; i < 3; i += 1) {
        socket.receive('ticket:updated', { ticket: makeSummary({ p1EscalationStep: 1 }) });
      }
    });
    expect(api.calls).toHaveLength(1);
    await waitFor(() => expect(lines()).toEqual(['P1 escalated to step 1', 'Ticket created']), {
      timeout: ACTIVITY_REFRESH_DEBOUNCE_MS + 1500,
    });
    await new Promise((resolve) => setTimeout(resolve, ACTIVITY_REFRESH_DEBOUNCE_MS + 100));
    expect(api.calls).toEqual([eventsPath(), eventsPath()]);
  });

  it('refetches after a reconnect while open', async () => {
    api.pages.set('', { items: [ev('CREATED')], nextCursor: null });
    renderActivity();
    await openSection();
    api.pages.set('', { items: [ev('REOPENED'), ev('CREATED')], nextCursor: null });
    act(() => socket.transportClose());
    act(() => socket.accept());
    await waitFor(() => expect(lines()).toEqual(['Ticket reopened', 'Ticket created']), {
      timeout: ACTIVITY_REFRESH_DEBOUNCE_MS + 1500,
    });
  });

  it('reloads whenever the section opens, showing what it had meanwhile', async () => {
    api.pages.set('', { items: [ev('CREATED')], nextCursor: null });
    renderActivity();
    await openSection();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(items()).toHaveLength(0);
    // Closed: updates are not followed.
    act(() => socket.receive('ticket:updated', { ticket: makeSummary() }));

    api.pages.set('', { items: [ev('REOPENED'), ev('CREATED')], nextCursor: null });
    fireEvent.click(toggle());
    // The cached events show at once (no skeleton), then the fresh ones.
    expect(lines()).toEqual(['Ticket created']);
    await waitFor(() => expect(lines()).toEqual(['Ticket reopened', 'Ticket created']));
    expect(api.calls).toEqual([eventsPath(), eventsPath()]);
  });

  it('says when there is nothing yet, and offers a retry when the events fail to load', async () => {
    api.pages.set('', { items: [], nextCursor: null });
    renderActivity();
    fireEvent.click(toggle());
    expect(await screen.findByText('No activity yet.')).toBeTruthy();
    cleanup();

    api.pages.set('', new ApiRequestError(404, 'NOT_FOUND', 'gone'));
    renderActivity();
    fireEvent.click(toggle());
    expect(await screen.findByText('The activity couldn’t be loaded.')).toBeTruthy();
    api.pages.set('', { items: [ev('CREATED')], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(lines()).toEqual(['Ticket created']));
  });

  it('is never rendered for clients (and never asks for the events)', () => {
    api.pages.set('', { items: [ev('CREATED')], nextCursor: null });
    const { container } = renderActivity({ viewer: CLIENT });
    expect(container.querySelector('[data-activity]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(api.calls).toEqual([]);
    expect(within(container).queryByText('Activity')).toBeNull();
  });
});
