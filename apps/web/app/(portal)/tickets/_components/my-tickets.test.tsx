// @vitest-environment jsdom
import { MAX_TICKET_ROOMS_PER_SOCKET, type TicketList, type TicketSummaryDto } from '@loons/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import type { RealtimeClient } from '@/lib/realtime/client';
import { fixtureId, makeSummary } from '@/lib/tickets/test-fixtures';
import { MAX_LIVE_ROWS, MyTickets } from './my-tickets';
import { createPortalHarness, deferred, type PortalHarness } from './portal-test-utils';

const api = vi.hoisted(() => ({
  fetchTickets: vi.fn(),
  fetchTicketCounts: vi.fn(),
  fetchTicket: vi.fn(),
  fetchAllMessages: vi.fn(),
}));
vi.mock('@/lib/tickets/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

const holder = vi.hoisted(() => ({ client: null as RealtimeClient | null }));
vi.mock('@/lib/realtime/client', async (importOriginal) => ({
  ...(await importOriginal()),
  getRealtimeClient: () => holder.client,
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const T1 = makeSummary({
  id: fixtureId(911),
  number: 4771,
  ref: 'LG-4771',
  subject: 'NVR recording failure – Building 3 cameras not recording',
  status: 'OPEN',
  preview: 'Cameras on Building 3 show live view but nothing has been recorded.',
  updatedAt: '2026-09-23T12:00:00.000Z',
});
const T2 = makeSummary({
  id: fixtureId(912),
  number: 4829,
  ref: 'LG-4829',
  subject: 'Preventive maintenance scheduling – Q4 CCTV PPM',
  status: 'PENDING',
  preview: 'Please propose dates for the Q4 CCTV PPM.',
  updatedAt: '2026-09-23T11:00:00.000Z',
});
const T3 = makeSummary({
  id: fixtureId(913),
  number: 4752,
  ref: 'LG-4752',
  subject: 'Access rights change – new ward staff',
  status: 'SOLVED',
  preview: 'Done — all six cards now open ward 4.',
  updatedAt: '2026-09-22T09:00:00.000Z',
});

const page = (items: TicketSummaryDto[], nextCursor: string | null = null): TicketList => ({
  items,
  nextCursor,
});
const counts = (all: number, active: number, solved: number) => ({
  kind: 'client' as const,
  tabs: { all, active, solved },
});

/** Answers GET /tickets like the API would for each tab. */
function serveTabs(tickets: TicketSummaryDto[]) {
  api.fetchTickets.mockImplementation(async (filters: { tab?: string }) => {
    const done = (t: TicketSummaryDto) => t.status === 'SOLVED' || t.status === 'CLOSED';
    if (filters.tab === 'active') return page(tickets.filter((t) => !done(t)));
    if (filters.tab === 'solved') return page(tickets.filter(done));
    return page(tickets);
  });
}

let harness: PortalHarness;

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.fetchTicketCounts.mockResolvedValue(counts(3, 2, 1));
  harness = createPortalHarness();
  holder.client = harness.client;
  window.history.replaceState(null, '', '/tickets');
});
afterEach(cleanup);

function renderList(initialTab: 'all' | 'active' | 'solved' = 'all', h = harness) {
  return render(<MyTickets firstName="Aisha" initialTab={initialTab} />, { wrapper: h.wrapper });
}

const rows = () =>
  within(screen.getByRole('list', { name: 'Your tickets' }))
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');

describe('My tickets', () => {
  it('shows skeleton rows, then the list with counts, ids, categories and previews', async () => {
    const list = deferred<TicketList>();
    api.fetchTickets.mockReturnValueOnce(list.promise);
    renderList();

    expect(screen.getByRole('status').textContent).toBe('Loading your tickets…');
    expect(screen.getByRole('heading', { level: 1, name: 'My tickets' })).toBeTruthy();
    expect(screen.getByText('Hi Aisha — track and reply to your support requests.')).toBeTruthy();

    await act(async () => list.resolve(page([T1, T2, T3])));

    expect(api.fetchTickets).toHaveBeenCalledWith(
      { tab: 'all', scope: 'mine', sort: 'recent' },
      null,
      expect.anything(),
    );
    const listEl = await screen.findByRole('list', { name: 'Your tickets' });
    const links = within(listEl).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/tickets/LG-4771',
      '/tickets/LG-4829',
      '/tickets/LG-4752',
    ]);
    const first = links[0]!;
    expect(within(first).getByText(T1.subject)).toBeTruthy();
    expect(first.textContent).toContain('LG-4771 · CCTV & Video Surveillance');
    expect(first.textContent).toContain(T1.preview);
    expect(within(first).getByText('Open')).toBeTruthy();
    expect(within(links[2]!).getByText('Solved')).toBeTruthy();
    // DA-9: the Card clips overflow, so rows draw an inset focus ring instead of the global
    // outline (whose sides and top would be cut off).
    for (const cls of ['outline-none', 'focus-visible:ring-2', 'focus-visible:ring-inset']) {
      expect(first.classList.contains(cls)).toBe(true);
    }

    await waitFor(() =>
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'All3',
        'Active2',
        'Solved1',
      ]),
    );
  });

  it('loads each tab from the API and keeps the tab in the URL', async () => {
    serveTabs([T1, T2, T3]);
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Solved/ }), { button: 0 });
    // The previous rows are filtered to the new tab at once (no skeleton flash)…
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain(T3.subject);
    expect(api.fetchTickets).toHaveBeenLastCalledWith(
      { tab: 'solved', scope: 'mine', sort: 'recent' },
      null,
      expect.anything(),
    );
    expect(window.location.search).toBe('?tab=solved');

    fireEvent.mouseDown(screen.getByRole('tab', { name: /All/ }), { button: 0 });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(window.location.search).toBe('');
  });

  it('shows the empty state with a New ticket button', async () => {
    api.fetchTickets.mockResolvedValue(page([]));
    api.fetchTicketCounts.mockResolvedValue(counts(0, 0, 0));
    renderList('active');
    expect(await screen.findByText('No tickets here')).toBeTruthy();
    expect(
      screen.getByText('Need help with something? We usually reply within an hour.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New ticket' })).toBeTruthy();
  });

  it('offers a retry when the list fails to load', async () => {
    // A 5xx is retried once (after ~1 s) before the error shows.
    api.fetchTickets.mockRejectedValue(new ApiRequestError(500, 'INTERNAL', 'boom'));
    renderList();
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert.textContent).toContain("Your tickets couldn't be loaded.");

    api.fetchTickets.mockResolvedValueOnce(page([T1]));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('loads the next page on demand', async () => {
    const T4 = makeSummary({
      id: fixtureId(914),
      number: 4700,
      ref: 'LG-4700',
      subject: 'Older ticket',
      updatedAt: '2026-09-01T09:00:00.000Z',
    });
    api.fetchTickets
      .mockResolvedValueOnce(page([T1, T2], 'cursor-1'))
      .mockResolvedValueOnce(page([T4], null));
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Show more tickets' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(api.fetchTickets).toHaveBeenLastCalledWith(
      { tab: 'all', scope: 'mine', sort: 'recent' },
      'cursor-1',
      expect.anything(),
    );
    expect(screen.queryByRole('button', { name: 'Show more tickets' })).toBeNull();
  });

  it('joins the rows’ ticket rooms and applies realtime updates in place', async () => {
    serveTabs([T1, T2]);
    renderList('active');
    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => harness.socket().accept());
    expect(
      harness
        .socket()
        .eventsNamed('ticket:join')
        .map((p) => (p as { ticketId: string }).ticketId)
        .sort(),
    ).toEqual([T1.id, T2.id].sort());

    // An agent replies on the older ticket: new preview, and it moves to the top.
    act(() =>
      harness.socket().receive('ticket:updated', {
        ticket: {
          ...T2,
          status: 'OPEN',
          preview: 'We can come on Sunday.',
          updatedAt: '2026-09-23T13:00:00.000Z',
        },
      }),
    );
    await waitFor(() => expect(rows()[0]).toContain(T2.subject));
    expect(rows()[0]).toContain('We can come on Sunday.');

    // Solved by the agent: it leaves the Active tab without a reload.
    act(() =>
      harness.socket().receive('ticket:updated', {
        ticket: { ...T1, status: 'SOLVED', updatedAt: '2026-09-23T14:00:00.000Z' },
      }),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toContain(T2.subject);
  });

  it('joins the rooms of the newest rows only, well below the server’s rooms cap', async () => {
    expect(MAX_LIVE_ROWS).toBe(MAX_TICKET_ROOMS_PER_SOCKET - 10);
    const many = Array.from({ length: MAX_TICKET_ROOMS_PER_SOCKET + 5 }, (_, i) =>
      makeSummary({
        id: fixtureId(2000 + i),
        number: 3000 + i,
        ref: `LG-${3000 + i}`,
        subject: `Ticket ${i}`,
        status: 'OPEN',
        updatedAt: new Date(Date.UTC(2026, 8, 23, 12, 0, 0) - i * 60_000).toISOString(),
      }),
    );
    serveTabs(many);
    renderList('active');
    await waitFor(() => expect(rows()).toHaveLength(many.length));
    act(() => harness.socket().accept());
    const joined = harness
      .socket()
      .eventsNamed('ticket:join')
      .map((p) => (p as { ticketId: string }).ticketId);
    expect(joined).toHaveLength(MAX_TICKET_ROOMS_PER_SOCKET - 10);
    expect(joined.sort()).toEqual(
      many
        .slice(0, MAX_TICKET_ROOMS_PER_SOCKET - 10)
        .map((t) => t.id)
        .sort(),
    );
  });

  it('warms a ticket’s detail and thread when its row is hovered', async () => {
    api.fetchTickets.mockResolvedValue(page([T1]));
    api.fetchTicket.mockResolvedValue({ ...T1 });
    api.fetchAllMessages.mockResolvedValue([]);
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.pointerEnter(screen.getByRole('link', { name: new RegExp(T1.subject) }));
    await waitFor(() => expect(api.fetchTicket).toHaveBeenCalledWith('LG-4771', expect.anything()));
    expect(api.fetchAllMessages).toHaveBeenCalledWith(T1.id, expect.anything());
  });

  it('refreshes the list when the browser tab becomes visible again', async () => {
    api.fetchTickets.mockResolvedValue(page([T1]));
    renderList();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const calls = api.fetchTickets.mock.calls.length;
    api.fetchTickets.mockResolvedValue(page([T1, T2]));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.fetchTickets.mock.calls.length).toBeGreaterThan(calls);
  });

  it('renders in Arabic with Arabic category labels and Latin ticket ids', async () => {
    const ar = createPortalHarness({ locale: 'ar' });
    holder.client = ar.client;
    api.fetchTickets.mockResolvedValue(
      page([
        {
          ...T1,
          category: { ...T1.category, labelAr: 'الدوائر التلفزيونية والمراقبة بالفيديو' },
        },
      ]),
    );
    render(<MyTickets firstName="Aisha" initialTab="all" />, { wrapper: ar.wrapper });
    const list = await screen.findByRole('list', { name: 'تذاكرك' });
    const link = within(list).getByRole('link');
    expect(link.textContent).toContain('LG-4771 · الدوائر التلفزيونية والمراقبة بالفيديو');
    expect(within(link).getByText('مفتوحة')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'تذاكري' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /الكل/ })).toBeTruthy();
  });
});
