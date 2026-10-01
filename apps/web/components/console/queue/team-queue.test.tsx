// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleSearchBox, ConsoleSearchProvider } from '@/components/shell/console-search';
import { queueKeys } from '@/lib/queue/keys';
import { ticketKeys } from '@/lib/tickets/keys';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import { WORLD_CONFIG, WORLD_PEOPLE, createInboxWorld, type InboxWorld } from '../test-world';
import { QueueSkeleton } from './queue-skeleton';
import { QUEUE_TIME_REFRESH_MS, TeamQueue } from './team-queue';

// ── The API: the in-memory console world behind the real fetchers (schema-checked answers). ──
const api = vi.hoisted(() => ({
  world: null as InboxWorld | null,
  calls: [] as { method: string; path: string; body?: unknown }[],
  /** Paths (prefixes) that answer 500 until cleared. */
  failing: [] as string[],
  /** Slows every response down (to observe pending states). */
  delayMs: 0,
}));
vi.mock('@/lib/api/browser', async () => {
  const { worldRequest } = await import('../test-world');
  const { ApiRequestError } = await import('@/lib/api/errors');
  const call = (method: 'GET' | 'POST' | 'PATCH') => async (path: string, body?: unknown) => {
    api.calls.push({ method, path, body });
    if (api.delayMs) await new Promise((resolve) => setTimeout(resolve, api.delayMs));
    if (api.failing.some((prefix) => path.startsWith(prefix))) {
      throw new ApiRequestError(500, 'INTERNAL', 'Broken by the test');
    }
    return worldRequest(api.world!, method, path, body);
  };
  return {
    apiClient: { get: call('GET'), post: call('POST'), patch: call('PATCH') },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

// ── next/navigation: search params follow the History API (and Back), like the App Router. ──
vi.mock('next/navigation', async () => {
  const React = await import('react');
  const listeners = new Set<() => void>();
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      listeners.forEach((listener) => listener());
    };
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    window.addEventListener('popstate', listener);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('popstate', listener);
    };
  };
  const useHref = () => React.useSyncExternalStore(subscribe, () => window.location.href);
  return {
    useSearchParams: () => {
      const href = useHref();
      return React.useMemo(() => new URL(href).searchParams, [href]);
    },
    usePathname: () => new URL(useHref()).pathname,
    useRouter: () => router,
  };
});

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  api.world = createInboxWorld({ now: Date.now() });
  api.calls = [];
  api.failing = [];
  api.delayMs = 0;
  toast.error.mockReset();
  toast.success.mockReset();
  router.push.mockReset();
  window.history.replaceState(null, '', '/console/queue');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MESSAGES = {
  en: { common: enCommon, console: enConsole, tickets: enTickets, errors: enErrors },
  ar: { common: arCommon, console: arConsole, tickets: arTickets, errors: arErrors },
};

function renderQueue(
  url = '/console/queue',
  options: { locale?: 'en' | 'ar'; withSearch?: boolean; queryClient?: QueryClient } = {},
) {
  const { locale = 'en', withSearch = false } = options;
  window.history.replaceState(null, '', url);
  const queryClient =
    options.queryClient ??
    new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = withSearch ? (
    <ConsoleSearchProvider>
      <ConsoleSearchBox />
      <TeamQueue />
    </ConsoleSearchProvider>
  ) : (
    <TeamQueue />
  );
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={api.world!.viewer}>{page}</ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const slow = { timeout: 5_000 };
const table = () => screen.getByRole('table', { name: 'Team queue tickets' });
/** The refs of the rows on screen, in order. */
const refs = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-row-open]')).map((a) =>
    a.getAttribute('data-ticket-ref'),
  );
const rowOf = (ref: string) =>
  document
    .querySelector<HTMLElement>(`[data-ticket-ref="${ref}"]`)!
    .closest<HTMLElement>('[role="row"]')!;
const tab = (name: RegExp) => screen.getByRole('tab', { name });
const FILTER_LABELS = {
  en: { priority: 'Priority filter', category: 'Category filter', assignee: 'Assignee filter' },
  ar: {
    priority: 'تصفية حسب الأولوية',
    category: 'تصفية حسب الفئة',
    assignee: 'تصفية حسب المسؤول',
  },
} as const;
/** A filter select by its accessible name (UI gap G1: a combobox isn't named by its text). */
const filter = (name: 'priority' | 'category' | 'assignee', locale: 'en' | 'ar' = 'en') =>
  screen.getByRole('combobox', { name: FILTER_LABELS[locale][name] });
const bulkBar = () => screen.queryByRole('group', { name: 'Bulk actions' });
const selectionStatus = () => document.querySelector('[data-selection-status]')!;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const listCalls = () =>
  api.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/tickets?'));
const lastListCall = () => new URL(listCalls().at(-1)!.path, 'http://x').searchParams;

/** Opens a Radix select with the keyboard and picks the option whose text starts with `label`. */
async function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const option = await screen.findByRole('option', { name: new RegExp(`^${escape(label)}`) });
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

async function loaded(expected: string[]) {
  await waitFor(() => expect(refs()).toEqual(expected), slow);
}

const ALL_OPEN = ['LG-4771', 'LG-4817', 'LG-4809', 'LG-4821', 'LG-4790', 'LG-4829'];

describe('Team queue', () => {
  it('shows the header, agent cards, tab counts and the open tickets P1 → P4', async () => {
    renderQueue();
    expect(screen.getByRole('heading', { level: 1, name: 'Team queue' })).toBeTruthy();
    // The unassigned count is the unfiltered Inbox count; agents see "Your teams".
    expect(await screen.findByText('Your teams · 2 unassigned')).toBeTruthy();

    await loaded(ALL_OPEN);
    const call = lastListCall();
    expect(call.get('view')).toBe('open');
    expect(call.get('sort')).toBe('priority');

    await waitFor(() => expect(tab(/^All open/).textContent).toBe('All open6'));
    expect(tab(/^Unassigned/).textContent).toBe('Unassigned2');
    expect(tab(/^Breaching soon/).textContent).toBe('Breaching soon1');
    expect(tab(/^Solved/).textContent).toBe('Solved1');
    expect(tab(/^All open/).getAttribute('aria-selected')).toBe('true');

    // Agent cards: most loaded first, capacity bar, "N at risk" in red or "On track".
    const agents = screen.getByRole('region', { name: 'Agent workload' });
    const cards = within(agents).getAllByRole('button');
    expect(cards.map((card) => card.getAttribute('data-agent-id'))).toEqual([
      WORLD_PEOPLE.priya.id,
      WORLD_PEOPLE.maya.id,
      WORLD_PEOPLE.theo.id,
      WORLD_PEOPLE.lina.id,
      WORLD_PEOPLE.rashid.id,
    ]);
    const priya = cards[0]!;
    expect(priya.textContent).toContain('Priya Shah');
    expect(priya.textContent).toContain('ELV Field +1');
    expect(within(priya).getByText('2 open tickets')).toBeTruthy();
    const note = within(priya).getByText('1 at risk · capacity 6');
    expect(note.className).toContain('text-danger');
    expect(priya.querySelector<HTMLElement>('[data-capacity-bar]')!.style.width).toBe(
      `${(2 / 6) * 100}%`,
    );
    expect(within(cards[1]!).getByText('On track · capacity 6').className).toContain(
      'text-ink-secondary',
    );
    expect(priya.getAttribute('aria-pressed')).toBe('false');

    // A row: priority pill, subject, "LG-n · category", requester + org, SLA, assignee, status.
    const row = rowOf('LG-4771');
    expect(within(row).getByText('P1 Critical')).toBeTruthy();
    expect(row.textContent).toContain('NVR recording failure – Building 3 cameras not recording');
    expect(row.textContent).toContain('LG-4771·CCTV & Video Surveillance');
    expect(row.textContent).toContain('Hamad Medical Corporation');
    expect(within(row).getByText(/^Overdue/)).toBeTruthy();
    expect(row.querySelector('[data-sla-bar="overdue"]')).not.toBeNull();
    expect(row.textContent).toContain('Priya Shah');
    expect(within(row).getByText('Open').getAttribute('data-status')).toBe('OPEN');
    expect(within(rowOf('LG-4790')).getByText('Unassigned')).toBeTruthy();
    // The header's column labels and the select-all checkbox.
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Select all',
      'Priority',
      'Ticket',
      'Requester',
      'First reply SLA',
      'Assignee',
      'Status',
    ]);
  });

  it('says "All teams" to a Super Admin', async () => {
    api.world = createInboxWorld({
      now: Date.now(),
      viewer: { ...WORLD_PEOPLE.maya, role: 'SUPER_ADMIN' },
    });
    renderQueue();
    expect(await screen.findByText('All teams · 2 unassigned')).toBeTruthy();
  });

  it('keeps the tab and filters in the URL, sends them to the API, and Back restores them', async () => {
    const av = WORLD_CONFIG.categories.find((c) => c.key === 'av')!;
    renderQueue('/console/queue?tab=unassigned&priority=P3');
    await loaded(['LG-4790']);
    expect(tab(/^Unassigned/).getAttribute('aria-selected')).toBe('true');
    expect(filter('priority').textContent).toBe('Priority: P3 Medium');
    let call = lastListCall();
    expect(call.get('view')).toBe('unassigned');
    expect(call.get('priority')).toBe('P3');
    // Tab counts follow the filters.
    await waitFor(() => expect(tab(/^All open/).textContent).toBe('All open1'));
    const counts = api.calls.filter((c) => c.path.startsWith('/tickets/queue-counts'));
    expect(new URL(counts.at(-1)!.path, 'http://x').searchParams.get('priority')).toBe('P3');

    // Category (labels keep their prefix) → pushed to the URL and sent to the API.
    await waitFor(() => expect(filter('category').textContent).toBe('Category: any'));
    await choose(filter('category'), 'Audio Visual');
    await waitFor(() =>
      expect(window.location.search).toBe(`?tab=unassigned&priority=P3&category=${av.id}`),
    );
    expect(filter('category').textContent).toBe('Category: ⁨Audio Visual⁩');
    await waitFor(() => expect(lastListCall().get('categoryId')).toBe(av.id));
    call = lastListCall();
    expect(call.get('priority')).toBe('P3');
    await loaded(['LG-4790']);

    // Priority back to "any": only the other filters stay.
    await choose(filter('priority'), 'Priority: any');
    await waitFor(() => expect(window.location.search).toBe(`?tab=unassigned&category=${av.id}`));

    // Back restores the previous filters (history entries, not replace).
    act(() => window.history.back());
    await waitFor(() =>
      expect(window.location.search).toBe(`?tab=unassigned&priority=P3&category=${av.id}`),
    );
    await waitFor(() => expect(filter('priority').textContent).toBe('Priority: P3 Medium'));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe('?tab=unassigned&priority=P3'));
    await waitFor(() => expect(filter('category').textContent).toBe('Category: any'));
  }, 15_000);

  it('switches tabs with the pointer or the keyboard (arrows move, Enter opens)', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    fireEvent.mouseDown(tab(/^Solved/));
    await waitFor(() => expect(window.location.search).toBe('?tab=solved'));
    await loaded(['LG-4752']);
    let call = lastListCall();
    expect(call.get('view')).toBe('solved');
    expect(call.get('sort')).toBe('recent');

    // Manual activation: arrows only move focus (no URL change per key press).
    act(() => tab(/^Solved/).focus());
    fireEvent.keyDown(tab(/^Solved/), { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(tab(/^Breaching soon/)));
    expect(window.location.search).toBe('?tab=solved');
    fireEvent.keyDown(tab(/^Breaching soon/), { key: 'Enter' });
    await waitFor(() => expect(window.location.search).toBe('?tab=breaching'));
    await loaded(['LG-4771']);
    call = lastListCall();
    expect(call.get('view')).toBe('risk');
    expect(call.get('sort')).toBe('priority');
  });

  it('toggles the Assignee filter from an agent card (and "Unassigned" sends none)', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    const card = () =>
      document.querySelector<HTMLElement>(`[data-agent-id="${WORLD_PEOPLE.priya.id}"]`)!;
    fireEvent.click(card());
    await waitFor(() => expect(window.location.search).toBe(`?assignee=${WORLD_PEOPLE.priya.id}`));
    await loaded(['LG-4771', 'LG-4821']);
    expect(lastListCall().get('assigneeId')).toBe(WORLD_PEOPLE.priya.id);
    expect(card().getAttribute('aria-pressed')).toBe('true');
    expect(card().className).toContain('border-brand');
    expect(filter('assignee').textContent).toBe('Assignee: ⁨Priya Shah⁩');

    fireEvent.click(card());
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(card().getAttribute('aria-pressed')).toBe('false');
    await loaded(ALL_OPEN);

    await choose(filter('assignee'), 'Unassigned');
    await waitFor(() => expect(window.location.search).toBe('?assignee=none'));
    await loaded(['LG-4790', 'LG-4829']);
    expect(lastListCall().get('assigneeId')).toBe('none');
  });

  it('selects rows (select-all = the loaded rows), announces the count, and a tab switch clears it', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    expect(bulkBar()).toBeNull();
    fireEvent.click(within(rowOf('LG-4790')).getByRole('checkbox', { name: 'Select LG-4790' }));
    expect(bulkBar()!.textContent).toContain('1 selected');
    await waitFor(() => expect(selectionStatus().textContent).toBe('1 selected'));
    expect(rowOf('LG-4790').className).toContain('bg-brand-wash-subtle');
    const selectAll = screen.getByRole('checkbox', { name: 'Select all tickets shown' });
    expect(selectAll.getAttribute('aria-checked')).toBe('mixed');

    fireEvent.click(selectAll);
    expect(bulkBar()!.textContent).toContain('6 selected');
    expect(selectAll.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(selectAll);
    await waitFor(() => expect(bulkBar()).toBeNull());

    fireEvent.click(within(rowOf('LG-4829')).getByRole('checkbox'));
    expect(bulkBar()).not.toBeNull();
    // Switching tab clears the selection (it does not come back with the tab).
    fireEvent.mouseDown(tab(/^Unassigned/));
    await waitFor(() => expect(window.location.search).toBe('?tab=unassigned'));
    await waitFor(() => expect(bulkBar()).toBeNull());
    await loaded(['LG-4790', 'LG-4829']);
    expect(within(rowOf('LG-4829')).getByRole('checkbox').getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.mouseDown(tab(/^All open/));
    await loaded(ALL_OPEN);
    expect(bulkBar()).toBeNull();
    expect(selectionStatus().textContent).toBe('');
  });

  it('Clear empties the selection and puts focus back on the select-all checkbox', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    fireEvent.click(within(rowOf('LG-4817')).getByRole('checkbox'));
    const clear = within(bulkBar()!).getByRole('button', { name: 'Clear' });
    act(() => clear.focus());
    fireEvent.click(clear);
    await waitFor(() => expect(bulkBar()).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole('checkbox', { name: 'Select all tickets shown' }),
    );
  });

  it('assigns the selection to the viewer, toasts, and refreshes the queue and the Inbox caches', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // An Inbox list and a ticket detail cached from another page.
    queryClient.setQueryData(ticketKeys.list({ view: 'unassigned' }), {
      pages: [],
      pageParams: [],
    });
    const detailId = api.world!.getTicket('LG-4790').id;
    queryClient.setQueryData(ticketKeys.detail('LG-4790'), { id: detailId });
    queryClient.setQueryData(ticketKeys.detail('LG-4817'), {
      id: api.world!.getTicket('LG-4817').id,
    });
    renderQueue('/console/queue?tab=unassigned', { queryClient });
    await loaded(['LG-4790', 'LG-4829']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all tickets shown' }));
    expect(bulkBar()!.textContent).toContain('2 selected');

    const assign = within(bulkBar()!).getByRole('button', { name: 'Assign to me' });
    act(() => assign.focus());
    fireEvent.click(assign);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 tickets assigned to you'));
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/tickets/bulk');
    expect(post?.body).toEqual({
      ids: [detailId, api.world!.getTicket('LG-4829').id],
      action: 'assignToMe',
    });
    // NEW → OPEN when assigned (the API's rule, mirrored by the world).
    expect(api.world!.getTicket('LG-4790').status).toBe('OPEN');
    await waitFor(() => expect(bulkBar()).toBeNull());

    // The queue refetches: the rows left the Unassigned tab, counts and the header follow.
    await loaded([]);
    expect(screen.getByText('No tickets match these filters.')).toBeTruthy();
    // The focus went from the closing bar to select-all, and stays there although nothing is
    // left to select: aria-disabled, never disabled (which would drop it to the page; UI G2).
    const selectAll = screen.getByRole('checkbox', { name: 'Select all tickets shown' });
    expect(selectAll.getAttribute('aria-disabled')).toBe('true');
    expect(selectAll.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(selectAll);
    fireEvent.click(selectAll);
    expect(bulkBar()).toBeNull();
    await waitFor(() => expect(tab(/^Unassigned/).textContent).toBe('Unassigned0'));
    expect(await screen.findByText('Your teams · 0 unassigned')).toBeTruthy();
    await waitFor(() =>
      expect(
        document.querySelector(`[data-agent-id="${WORLD_PEOPLE.maya.id}"]`)?.textContent,
      ).toContain('3 open tickets'),
    );
    // The Inbox's caches and the touched ticket's detail are stale; other details are not.
    expect(queryClient.getQueryState(ticketKeys.list({ view: 'unassigned' }))?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(ticketKeys.detail('LG-4790'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(ticketKeys.detail('LG-4817'))?.isInvalidated).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a partial failure with the count and one reason', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    fireEvent.click(within(rowOf('LG-4790')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('LG-4829')).getByRole('checkbox'));
    // Someone closes LG-4829 meanwhile: the API refuses it (conflict), the other one is solved.
    api.world!.getTicket('LG-4829').status = 'CLOSED';
    fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Mark solved' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith(
      '1 ticket marked solved · 1 ticket couldn’t be changed',
      { description: 'LG-4829 is closed, so it can’t be changed.' },
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.world!.getTicket('LG-4790').status).toBe('SOLVED');
    await loaded(['LG-4771', 'LG-4817', 'LG-4809', 'LG-4821']);
  });

  it('turns a failed bulk request into failures with the API error', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    fireEvent.click(within(rowOf('LG-4821')).getByRole('checkbox'));
    api.failing = ['/tickets/bulk'];
    fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error.mock.calls[0]![0]).toBe('1 ticket couldn’t be changed');
    expect(toast.error.mock.calls[0]![1]).toEqual({ description: expect.any(String) });
    // Nothing changed: the selection stays, so the viewer can try again.
    expect(bulkBar()!.textContent).toContain('1 selected');
    expect(within(rowOf('LG-4821')).getByRole('checkbox').getAttribute('aria-checked')).toBe(
      'true',
    );
    api.failing = [];
    fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 ticket assigned to you'));
    await waitFor(() => expect(bulkBar()).toBeNull());
  });

  it('says apart the tickets that already were that way (never counted as changed)', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    // LG-4817 is already the viewer's; LG-4790 is unassigned.
    fireEvent.click(within(rowOf('LG-4817')).getByRole('checkbox'));
    fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Assign to me' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('1 ticket was already assigned to you'),
    );
    await waitFor(() => expect(bulkBar()).toBeNull());
    fireEvent.click(within(rowOf('LG-4817')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('LG-4790')).getByRole('checkbox'));
    fireEvent.click(within(bulkBar()!).getByRole('button', { name: 'Assign to me' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenLastCalledWith(
        '1 ticket assigned to you · 1 ticket was already assigned to you',
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens a row in the Inbox (Solved view for solved tickets); the checkbox never does', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    const link = within(rowOf('LG-4771')).getByRole('link', { name: /NVR recording failure/ });
    expect(link.getAttribute('href')).toBe('/console/inbox?view=open&ticket=LG-4771');

    fireEvent.click(within(rowOf('LG-4771')).getByRole('checkbox'));
    expect(router.push).not.toHaveBeenCalled();

    // Keyboard: the row's link takes focus (the row draws the ring) and Enter activates it.
    act(() => link.focus());
    expect(document.activeElement).toBe(link);
    expect(rowOf('LG-4771').className).toContain('has-[[data-row-open]:focus-visible]:ring-2');
    fireEvent.click(link);
    expect(router.push).toHaveBeenCalledWith('/console/inbox?view=open&ticket=LG-4771');

    // A modified click is left to the browser (new tab); jsdom can't open one, so the document
    // swallows it after the row's handler has seen it.
    router.push.mockReset();
    const swallow = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('click', swallow);
    fireEvent.click(link, { ctrlKey: true });
    document.removeEventListener('click', swallow);
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.mouseDown(tab(/^Solved/));
    await loaded(['LG-4752']);
    fireEvent.click(within(rowOf('LG-4752')).getByRole('link'));
    expect(router.push).toHaveBeenCalledWith('/console/inbox?view=solved&ticket=LG-4752');
  });

  it('filters in place from the top-bar search (URL ?q=, list and tab counts)', async () => {
    renderQueue('/console/queue?tab=open&priority=P2', { withSearch: true });
    await loaded(['LG-4821']);
    const box = screen.getByRole('searchbox', { name: 'Search tickets' });
    fireEvent.change(box, { target: { value: 'nothing-like-this' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.location.search).toBe('?priority=P2&q=nothing-like-this');
    await loaded([]);
    expect(screen.getByText('No tickets match these filters.')).toBeTruthy();
    expect(lastListCall().get('search')).toBe('nothing-like-this');
    await waitFor(() => expect(tab(/^All open/).textContent).toBe('All open0'));
    const counts = api.calls.filter((c) => c.path.startsWith('/tickets/queue-counts'));
    expect(new URL(counts.at(-1)!.path, 'http://x').searchParams.get('search')).toBe(
      'nothing-like-this',
    );

    fireEvent.change(box, { target: { value: 'turnstile' } });
    await waitFor(() => expect(window.location.search).toBe('?priority=P2&q=turnstile'), slow);
    await loaded(['LG-4821']);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows an error with Try again when the list fails, then the rows', async () => {
    api.failing = ['/tickets?'];
    renderQueue();
    const alert = await screen.findByRole('alert', {}, slow);
    expect(alert.textContent).toContain('The tickets couldn’t be loaded.');
    api.failing = [];
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await loaded(ALL_OPEN);
  });

  it('shows the agent cards’ error with Try again', async () => {
    api.failing = ['/tickets/workload'];
    renderQueue();
    await loaded(ALL_OPEN);
    const agents = await screen.findByRole('region', { name: 'Agent workload' });
    expect(agents.textContent).toContain('The agent workload couldn’t be loaded.');
    api.failing = [];
    fireEvent.click(within(agents).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(document.querySelectorAll('[data-agent-id]')).toHaveLength(5));
  });

  it('loads more rows with the cursor, keeping the focus (then on the first new row)', async () => {
    api.world = createInboxWorld({ now: Date.now(), extraTickets: 4, pageSize: 5 });
    renderQueue();
    await waitFor(() => expect(refs()).toHaveLength(5), slow);
    const more = screen.getByRole('button', { name: 'Show more tickets' });
    act(() => more.focus());
    api.delayMs = 50;
    fireEvent.click(more);
    // While the page loads the button stays (so does the focus), saying so (UI gap G3).
    await waitFor(() => expect(more.textContent).toBe('Loading more tickets…'));
    expect(more.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(more);
    await waitFor(() => expect(refs()).toHaveLength(10), slow);
    expect(lastListCall().get('cursor')).toBe('5');
    expect(screen.queryByRole('button', { name: 'Show more tickets' })).toBeNull();
    const links = document.querySelectorAll<HTMLElement>('[data-row-open]');
    await waitFor(() => expect(document.activeElement).toBe(links[5]));
  });

  it('refreshes the list, counts and cards every 60 s while the tab is visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderQueue();
    await loaded(ALL_OPEN);
    const before = api.calls.length;
    api.world!.getTicket('LG-4829').assignee = {
      id: WORLD_PEOPLE.theo.id,
      name: WORLD_PEOPLE.theo.name,
    };
    act(() => vi.advanceTimersByTime(QUEUE_TIME_REFRESH_MS));
    await waitFor(() => expect(within(rowOf('LG-4829')).queryByText('Theo Kim')).not.toBeNull());
    const paths = api.calls.slice(before).map((c) => c.path.split('?')[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/tickets',
        '/tickets/queue-counts',
        '/tickets/workload',
        '/tickets/counts',
      ]),
    );
    // The filter options follow config changes only.
    expect(paths).not.toContain('/tickets/filter-options');
  });

  it('brings a tab reached with the keyboard into view (the phone strip scrolls sideways)', async () => {
    renderQueue();
    await loaded(ALL_OPEN);
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    act(() => tab(/^Solved/).focus());
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(scroll.mock.contexts.at(-1)).toBe(tab(/^Solved/));
  });

  it('marks the active tab and a pressed agent card in forced-colours mode too', async () => {
    renderQueue(`/console/queue?assignee=${WORLD_PEOPLE.priya.id}`);
    await waitFor(() => expect(refs().length).toBeGreaterThan(0), slow);
    // Forced colours paint every transparent border in the text colour: inactive tabs take the
    // background colour, the active one Highlight (UI gap G10).
    for (const trigger of screen.getAllByRole('tab')) {
      expect(trigger.className).toContain('forced-colors:border-[Canvas]!');
      expect(trigger.className).toContain('forced-colors:data-active:border-[Highlight]!');
    }
    const card = (id: string) => document.querySelector<HTMLElement>(`[data-agent-id="${id}"]`)!;
    await waitFor(() =>
      expect(card(WORLD_PEOPLE.priya.id).getAttribute('aria-pressed')).toBe('true'),
    );
    expect(card(WORLD_PEOPLE.priya.id).className).toContain('forced-colors:border-[Highlight]');
    expect(card(WORLD_PEOPLE.maya.id).className).not.toContain('forced-colors:border-[Highlight]');
  });

  it('truncates subjects, names and companies at their own end, in either script', async () => {
    renderQueue('/console/queue', { locale: 'ar' });
    await loaded(ALL_OPEN);
    // dir="auto": an English subject in the Arabic UI loses its end, not its start (UI gap G4).
    const row = rowOf('LG-4771');
    const subject = row.querySelector<HTMLElement>('[data-row-open]')!;
    expect(subject.getAttribute('dir')).toBe('auto');
    expect(subject.className).toContain('[text-align:match-parent]');
    for (const text of ['Priya Shah', 'مؤسسة حمد الطبية']) {
      const el = within(row).getByText(text);
      expect(el.getAttribute('dir'), text).toBe('auto');
      expect(el.className, text).toContain('truncate');
    }
    const agent = document.querySelector<HTMLElement>(
      `[data-agent-id="${WORLD_PEOPLE.priya.id}"]`,
    )!;
    expect(within(agent).getByText('Priya Shah').getAttribute('dir')).toBe('auto');
  });

  it('speaks Arabic: plural subtitle, isolated ticket ids, RTL-safe labels', async () => {
    renderQueue('/console/queue', { locale: 'ar' });
    expect(await screen.findByText('فرقك · تذكرتان غير مسندتين')).toBeTruthy();
    await loaded(ALL_OPEN);
    expect(
      within(rowOf('LG-4771')).getByRole('checkbox', {
        name: 'تحديد التذكرة ⁦LG-4771⁩',
      }),
    ).toBeTruthy();
    expect(tab(/^كل المفتوحة/)).toBeTruthy();
    expect(filter('priority', 'ar').textContent).toBe('الأولوية: الكل');
    expect(
      within(
        document.querySelector<HTMLElement>(`[data-agent-id="${WORLD_PEOPLE.priya.id}"]`)!,
      ).getByText('تذكرة واحدة معرضة للخطر · السعة 6'),
    ).toBeTruthy();
  });

  it('loading skeleton: the filter placeholders stay readable (ink-muted, never faded)', () => {
    render(
      <NextIntlClientProvider locale="en" timeZone="Asia/Qatar" messages={MESSAGES.en}>
        <QueueSkeleton />
      </NextIntlClientProvider>,
    );
    const placeholders = document.querySelectorAll<HTMLElement>('[data-filter-placeholder]');
    expect([...placeholders].map((el) => el.textContent)).toEqual([
      'Priority: any',
      'Category: any',
      'Assignee: anyone',
    ]);
    // Text with opacity fell to 2.85:1; ink-muted on the page is 4.6:1.
    for (const el of placeholders) {
      expect(el.className).toContain('text-ink-muted');
      expect(el.className).not.toMatch(/(^|\s)opacity-/);
    }
  });

  it('keeps its query keys under the queue prefix, never under the Inbox list prefix', async () => {
    const { queryClient } = renderQueue();
    await loaded(ALL_OPEN);
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys.some((k) => k[0] === 'queue' && k[1] === 'list')).toBe(true);
    expect(keys.some((k) => k[0] === 'tickets' && k[1] === 'list')).toBe(false);
    expect(queryClient.getQueryData(queueKeys.workload())).toBeTruthy();
  });
});
