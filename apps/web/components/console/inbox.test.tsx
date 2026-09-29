// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import arTickets from '@/messages/ar/tickets.json';
import arValidation from '@/messages/ar/validation.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';
import { Inbox } from './inbox';
import { WORLD_PEOPLE, WORLD_TEAMS, createInboxWorld, type InboxWorld } from './test-world';

// ── The API: an in-memory world behind the real fetchers (responses are schema-checked). ──
const api = vi.hoisted(() => ({
  world: null as InboxWorld | null,
  calls: [] as { method: string; path: string; body?: unknown }[],
  /** Slows every response down (to observe optimistic states). */
  delayMs: 0,
}));
vi.mock('@/lib/api/browser', async () => {
  const { worldRequest } = await import('./test-world');
  const call = (method: 'GET' | 'POST' | 'PATCH') => async (path: string, body?: unknown) => {
    api.calls.push({ method, path, body });
    if (api.delayMs) await new Promise((resolve) => setTimeout(resolve, api.delayMs));
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

// ── next/navigation: search params follow the History API, like the App Router does. ──
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
  return {
    useSearchParams: () => {
      const search = React.useSyncExternalStore(subscribe, () => window.location.search);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
    usePathname: () => window.location.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  };
});

let wide = true;
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
    matches: query.includes('min-width') ? wide : false,
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
  api.delayMs = 0;
  toast.error.mockReset();
  wide = true;
  window.localStorage.clear();
  window.history.replaceState(null, '', '/console/inbox');
});
afterEach(cleanup);

const MESSAGES = {
  en: {
    common: enCommon,
    console: enConsole,
    tickets: enTickets,
    validation: enValidation,
    errors: enErrors,
  },
  ar: {
    common: arCommon,
    console: arConsole,
    tickets: arTickets,
    validation: arValidation,
    errors: arErrors,
  },
};

function renderInbox(url = '/console/inbox', locale: 'en' | 'ar' = 'en') {
  window.history.replaceState(null, '', url);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={api.world!.viewer}>
          <Inbox />
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const list = () => screen.getByRole('list', { name: 'Tickets in this view' });
const panel = () => screen.getByRole('complementary', { name: 'Ticket details' });
const findPanel = () => screen.findByRole('complementary', { name: 'Ticket details' });
const findList = () => screen.findByRole('list', { name: 'Tickets in this view' });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Opens a Radix select with the keyboard and picks the option whose text starts with `label`. */
async function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const option = await screen.findByRole('option', { name: new RegExp(`^${escape(label)}`) });
  fireEvent.keyDown(option, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

describe('Inbox', () => {
  it('shows the views and teams with live counts and opens the first ticket', async () => {
    renderInbox();
    const views = screen.getByRole('navigation', { name: 'Views' });
    const mine = await within(views).findByRole('link', { name: /My queue\s*1/ });
    expect(mine.getAttribute('aria-current')).toBe('page');
    expect(within(views).getByRole('link', { name: /P1 critical\s*3/ })).toBeTruthy();
    const teams = screen.getByRole('navigation', { name: 'Teams' });
    expect(within(teams).getByRole('link', { name: /ELV Field\s*2/ })).toBeTruthy();

    // Design: wide layouts always show a conversation (the first row).
    await waitFor(() => expect(window.location.search).toBe('?ticket=LG-4817'));
    expect(
      await screen.findByRole('heading', {
        name: 'Security alert – multiple failed admin logins on firewall',
        level: 2,
      }),
    ).toBeTruthy();
    const row = within(list()).getByRole('link', { name: /Khalid Al-Mansouri · QNB/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toContain('LG-4817');
    expect(row.textContent).toContain('Open');
  });

  it('keeps the selected row’s muted text AA on the brand wash', async () => {
    // ink-muted is only 4.35:1 on brand-wash; ink-secondary is 6.96:1.
    const ref = (row: HTMLElement) => within(row).getByText(row.getAttribute('data-ticket-ref')!);
    const sla = (row: HTMLElement) => row.querySelector('[data-sla="done"]');

    renderInbox('/console/inbox?view=solved');
    const solved = await within(await findList()).findByRole('link', { current: true });
    expect(solved.className).toContain('bg-brand-wash');
    expect(ref(solved).className).toContain('text-ink-secondary');
    // The Solved view's "done" SLA text (ink-muted) goes darker on the selected row.
    expect(sla(solved)?.className).toContain('data-[sla=done]:text-ink-secondary');

    cleanup();
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    await waitFor(() => expect(within(list()).getAllByRole('link')).toHaveLength(6));
    const rows = within(list()).getAllByRole('link');
    const selected = rows.find((row) => row.getAttribute('aria-current') === 'true')!;
    const other = rows.find((row) => row !== selected)!;
    expect(ref(selected).className).toContain('text-ink-secondary');
    expect(ref(other).className).toContain('text-ink-muted');
  });

  it('switches views through the URL without reloading and sorts by SLA or recency', async () => {
    renderInbox();
    await screen.findByRole('heading', { level: 2, name: /Security alert/ });
    fireEvent.click(screen.getByRole('link', { name: /^All open/ }));
    await waitFor(() => expect(window.location.search).toMatch(/^\?view=open/));
    await waitFor(() => expect(within(list()).getAllByRole('link')).toHaveLength(6));
    const refs = () =>
      within(list())
        .getAllByRole('link')
        .map((a) => a.getAttribute('data-ticket-ref'));
    // SLA order: overdue first reply first, then the next due, paused (PENDING) last.
    expect(refs()).toEqual(['LG-4771', 'LG-4817', 'LG-4821', 'LG-4790', 'LG-4829', 'LG-4809']);

    fireEvent.click(screen.getByRole('button', { name: /Sorted by SLA/ }));
    expect(await screen.findByRole('button', { name: /Sorted by recent/ })).toBeTruthy();
    expect(window.localStorage.getItem('loons.console.inbox.sort')).toBe('recent');
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.path.startsWith('/tickets?') && c.path.includes('sort=recent')),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('link', { name: /^ELV Field/ }));
    await waitFor(() =>
      expect(window.location.search).toMatch(new RegExp(`^\\?team=${WORLD_TEAMS.elv.id}`)),
    );
    await waitFor(() => expect(within(list()).getAllByRole('link')).toHaveLength(2));
    expect(screen.getByRole('heading', { level: 2, name: /^ELV Field/ })).toBeTruthy();
  });

  it('switches views with the select used below 1180 px', async () => {
    renderInbox();
    await screen.findByRole('heading', { level: 2, name: /Security alert/ });
    const select = screen.getByRole('combobox', { name: 'Choose a view' });
    await choose(select, 'P1 critical (3)');
    await waitFor(() => expect(window.location.search).toMatch(/^\?view=p1/));
    await waitFor(() => expect(within(list()).getAllByRole('link')).toHaveLength(3));
    // Teams: the count follows a middle dot (names can end in "(SOC)" — no "(SOC) (3)").
    const trigger = screen.getByRole('combobox', { name: 'Choose a view' });
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect((await screen.findByRole('option', { name: /^NOC/ })).textContent).toMatch(
      /^NOC · \d+$/,
    );
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await choose(screen.getByRole('combobox', { name: 'Choose a view' }), 'NOC');
    await waitFor(() => expect(window.location.search).toBe(`?team=${WORLD_TEAMS.noc.id}`));
  });

  it('filters by the ?q= search and explains an empty result', async () => {
    renderInbox('/console/inbox?view=open&q=turnstile');
    await waitFor(() => expect(within(list()).getAllByRole('link')).toHaveLength(1));
    expect(within(list()).getByRole('link').getAttribute('data-ticket-ref')).toBe('LG-4821');

    cleanup();
    renderInbox('/console/inbox?view=solved&q=zzz');
    expect(await screen.findByText('No tickets in this view match “zzz”.')).toBeTruthy();
  });

  it('renders the thread with yellow internal notes and the requester card', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const note = await screen.findByText(/Blocked the 3 source IPs/);
    expect(note.closest('[data-kind]')?.getAttribute('data-kind')).toBe('internal');
    expect(note.closest('.bg-note-bg')).not.toBeNull();
    const line = screen.getByText(
      (_, el) => el?.tagName === 'P' && !!el.textContent?.startsWith('LG-4817 · '),
    );
    expect(line.textContent).toBe(
      'LG-4817 · Cybersecurity / SOC › Security alert / suspected incident · via portal · QNB – Head Office, West Bay',
    );

    const details = await findPanel();
    expect(await within(details).findByText('Khalid Al-Mansouri')).toBeTruthy();
    expect(within(details).getByText('Lina Haddad')).toBeTruthy();
    expect(within(details).getByText('3 sites')).toBeTruthy();
    expect(within(details).getByText('1 from this client')).toBeTruthy();
    expect(within(details).getByRole('radio', { name: 'Open' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('sends a public reply optimistically and predicts the new status', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4821');
    const box = await screen.findByRole('textbox', { name: 'Public reply to Fatima' });
    fireEvent.change(box, { target: { value: 'An engineer is on the way.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));

    // Optimistic: the bubble shows at once and the status moves to Pending (waiting on client).
    expect(await screen.findByText('An engineer is on the way.')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('');
    await waitFor(() =>
      expect(
        within(panel()).getByRole('radio', { name: 'Pending' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/tickets/${api.world!.getTicket('LG-4821').id}/messages`);
    expect(post?.body).toMatchObject({
      type: 'PUBLIC',
      body: 'An engineer is on the way.',
      andSolve: false,
    });
    expect(api.world!.getTicket('LG-4821').status).toBe('PENDING');
  });

  it('keeps separate drafts per mode and sends internal notes from a yellow composer', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4821');
    const reply = await screen.findByRole('textbox', { name: 'Public reply to Fatima' });
    fireEvent.change(reply, { target: { value: 'Public draft' } });

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Internal note' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Internal note' }));
    const note = await screen.findByRole('textbox', { name: /Internal note/ });
    expect(note.className).toContain('bg-note-composer');
    expect((note as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Send & solve' })).toBeNull();

    fireEvent.change(note, { target: { value: 'Spare reader in the van.' } });
    fireEvent.keyDown(note, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        type: 'INTERNAL',
        body: 'Spare reader in the van.',
      }),
    );
    const bubble = await screen.findByText('Spare reader in the van.');
    expect(bubble.closest('[data-kind]')?.getAttribute('data-kind')).toBe('internal');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Public reply' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Public reply' }));
    expect(
      (
        (await screen.findByRole('textbox', {
          name: 'Public reply to Fatima',
        })) as HTMLTextAreaElement
      ).value,
    ).toBe('Public draft');
  });

  it('refuses an empty message', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4821');
    await screen.findByRole('textbox', { name: 'Public reply to Fatima' });
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }));
    expect(screen.getByRole('alert').textContent).toBe('Write a message first.');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('fills macros and applies their status after an internal note', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4771');
    const reply = await screen.findByRole('textbox', { name: 'Public reply to Aisha' });
    fireEvent.click(await screen.findByRole('button', { name: 'Engineer dispatched' }));
    expect((reply as HTMLTextAreaElement).value).toBe(
      'Hi Aisha, an engineer has been dispatched to HMC – Building 3, Level 2. We’ll update you on arrival.',
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Internal note' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Internal note' }));
    await screen.findByRole('textbox', { name: /Internal note/ });
    fireEvent.click(screen.getByRole('button', { name: 'Awaiting client access' }));
    expect(
      screen.getByText('“Awaiting client access” sets the status to Pending when sent'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'PENDING' }),
    );
    const post = api.calls.findIndex((c) => c.method === 'POST');
    const patch = api.calls.findIndex((c) => c.method === 'PATCH');
    expect(post).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(post);
    await waitFor(() => expect(api.world!.getTicket('LG-4771').status).toBe('PENDING'));
  });

  it('Send & solve solves the ticket', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4821');
    const box = await screen.findByRole('textbox', { name: 'Public reply to Fatima' });
    fireEvent.change(box, { target: { value: 'Reader replaced.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & solve' }));
    await waitFor(() =>
      expect(
        within(panel()).getByRole('radio', { name: 'Solved' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(api.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ andSolve: true });
  });

  it('edits status and priority optimistically and rolls back a refused change', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const details = await findPanel();
    const pending = await within(details).findByRole('radio', { name: 'Pending' });
    fireEvent.click(pending);
    await waitFor(() => expect(pending.getAttribute('aria-checked')).toBe('true'));
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'PENDING' }),
    );

    await choose(within(details).getByRole('combobox', { name: /^Priority/ }), 'P2 High');
    await waitFor(() => expect(api.world!.getTicket('LG-4817').priority).toBe('P2'));
    expect(screen.getAllByText('P2 High').length).toBeGreaterThan(0);

    // The test world refuses the tag "fail": the chip disappears again and a toast explains.
    const tagInput = within(details).getByRole('textbox', { name: 'Add a tag' });
    api.delayMs = 80;
    fireEvent.change(tagInput, { target: { value: 'Fail' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(await within(details).findByRole('button', { name: 'Remove tag fail' })).toBeTruthy();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() =>
      expect(within(details).queryByRole('button', { name: 'Remove tag fail' })).toBeNull(),
    );

    // A visible focus indicator: brand border + ring (brand-tint alone is 1.14:1 on white).
    expect(tagInput.className).toContain('focus-visible:border-brand');

    fireEvent.change(tagInput, { target: { value: '-bad' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });
    expect(within(details).getByRole('alert').textContent).toBe(
      'Use lowercase letters, numbers and hyphens.',
    );
  });

  it('moves through the statuses with the arrow keys and saves only the one chosen', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const details = await findPanel();
    const group = within(details).getByRole('radiogroup', { name: 'Status' });
    const open = await within(group).findByRole('radio', { name: 'Open' });
    expect(open.getAttribute('aria-checked')).toBe('true');
    const press = async (key: string, expected: string) => {
      fireEvent.keyDown(document.activeElement!, { key });
      await waitFor(() => expect(document.activeElement?.textContent).toBe(expected));
      fireEvent.keyUp(document.activeElement!, { key });
    };
    const patches = () => api.calls.filter((c) => c.method === 'PATCH').map((c) => c.body);

    // Open → Pending → Solved and back to New: focus moves, nothing is saved or checked.
    act(() => open.focus());
    await press('ArrowRight', 'Pending');
    await press('ArrowRight', 'Solved');
    await press('Home', 'New');
    await press('ArrowRight', 'Open');
    await press('ArrowLeft', 'New');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches()).toEqual([]);
    expect(open.getAttribute('aria-checked')).toBe('true');
    expect(api.world!.getTicket('LG-4817').status).toBe('OPEN');

    // Enter / Space / a click picks the focused status: one PATCH.
    await press('End', 'Solved');
    fireEvent.click(document.activeElement!);
    await waitFor(() => expect(patches()).toEqual([{ status: 'SOLVED' }]));
    await waitFor(() =>
      expect(
        within(group).getByRole('radio', { name: 'Solved' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    // Choosing the current status again changes nothing.
    fireEvent.click(within(group).getByRole('radio', { name: 'Solved' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches()).toHaveLength(1);
  });

  it('shows the category’s asset example in the UI language (review DA-11)', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817', 'ar');
    const arPanel = await screen.findByRole('complementary', { name: arConsole.ticket.details });
    const asset = await within(arPanel).findByLabelText(arConsole.panel.assetId);
    // Cybersecurity / SOC's configured "e.g. FW-01", with the words around the ID translated. The
    // input stays dir="ltr" for the IDs typed into it, so the Arabic placeholder carries its own
    // direction (RLI … PDI) instead of reading "FW-01 :مثال", and the ID its own (LRI … PDI;
    // UI-RR-2).
    expect(asset.getAttribute('dir')).toBe('ltr');
    expect(asset.getAttribute('placeholder')).toBe('\u2067مثال: \u2066FW-01\u2069\u2069');
    cleanup();

    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const enAsset = await within(await findPanel()).findByLabelText('Asset ID');
    expect(enAsset.getAttribute('placeholder')).toBe('e.g. FW-01');
  });

  it.each([
    // Shown as configured (not an "e.g." shape): left-to-right, the full stop stays at the end.
    ['Serial on the label.', '\u2066Serial on the label.\u2069', 'Serial on the label.'],
    // A digit-first example: the ID keeps its order ("2026-018", not "018-2026").
    ['e.g. 2026-018', '\u2067مثال: \u20662026-018\u2069\u2069', 'e.g. 2026-018'],
  ])(
    'shows the asset placeholder %j in its own direction in the LTR editor (UI-RR-2)',
    async (configured, ar, en) => {
      const world = api.world!;
      const categoryId = world.getTicket('LG-4817').category.id;
      world.config = {
        ...world.config,
        categories: world.config.categories.map((c) =>
          c.id === categoryId ? { ...c, assetPlaceholder: configured } : c,
        ),
      };
      renderInbox('/console/inbox?view=open&ticket=LG-4817', 'ar');
      const arPanel = await screen.findByRole('complementary', { name: arConsole.ticket.details });
      const asset = await within(arPanel).findByLabelText(arConsole.panel.assetId);
      expect(asset.getAttribute('dir')).toBe('ltr');
      await waitFor(() => expect(asset.getAttribute('placeholder')).toBe(ar));
      cleanup();

      renderInbox('/console/inbox?view=open&ticket=LG-4817');
      const enAsset = await within(await findPanel()).findByLabelText('Asset ID');
      await waitFor(() => expect(enAsset.getAttribute('placeholder')).toBe(en));
    },
  );

  it('offers "Assign to me" to team members and opens a NEW ticket', async () => {
    const world = createInboxWorld();
    const ticket = world.getTicket('LG-4817');
    ticket.assignee = null;
    ticket.status = 'NEW';
    api.world = world;
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const assign = await within(await findPanel()).findByRole('button', { name: 'Assign to me' });
    fireEvent.click(assign);
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        assigneeId: WORLD_PEOPLE.maya.id,
        status: 'OPEN',
      }),
    );
    await waitFor(() =>
      expect(within(panel()).queryByRole('button', { name: 'Assign to me' })).toBeNull(),
    );

    // Not on the AV team: no "Assign to me" there.
    cleanup();
    renderInbox('/console/inbox?view=open&ticket=LG-4790');
    await within(await findPanel()).findByText('Capt. Omar Al-Naimi');
    expect(within(panel()).queryByRole('button', { name: 'Assign to me' })).toBeNull();
  });

  it('the thread scroller is a named, keyboard-focusable region (UI-RR-3)', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const log = await screen.findByRole('log');
    // The scroller wraps the thread; from 700 px it scrolls on its own, so a keyboard user must be
    // able to reach it (axe scrollable-region-focusable) and hear what it is.
    const scroller = log.closest('[tabindex="0"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    // Exactly one "Conversation" landmark: the scroller (the thread inside adds none; axe
    // landmark-unique).
    expect(screen.getByRole('region', { name: 'Conversation' })).toBe(scroller);
    // The focus indicator: an inset outline on an overlay of the non-scrolling wrapper, so it is
    // drawn above the message bubbles and survives forced-colors mode (a box-shadow ring on the
    // scroller did neither).
    const classes = (el: Element) => el.className.split(/\s+/);
    expect(classes(scroller!)).toContain('outline-none');
    expect(classes(scroller!).filter((c) => /ring/.test(c))).toEqual([]);
    const overlay = scroller!.parentElement!;
    expect(classes(overlay)).toEqual(
      expect.arrayContaining([
        'relative',
        'after:pointer-events-none',
        'after:absolute',
        'after:inset-0',
        'has-[>:focus-visible]:after:outline-2',
        'has-[>:focus-visible]:after:-outline-offset-2',
        'has-[>:focus-visible]:after:outline-brand',
      ]),
    );
    expect(overlay.children).toHaveLength(1);
    act(() => scroller!.focus());
    expect(document.activeElement).toBe(scroller);

    cleanup();
    renderInbox('/console/inbox?view=open&ticket=LG-4817', 'ar');
    const arLog = await screen.findByRole('log');
    expect(screen.getByRole('region', { name: arConsole.ticket.conversation })).toBe(
      arLog.closest('[tabindex="0"]'),
    );
  });

  it('shows a not-found state for tickets the agent can’t see', async () => {
    renderInbox('/console/inbox?ticket=LG-9999');
    expect(await screen.findByRole('heading', { name: 'Ticket not found' })).toBeTruthy();
  });

  it('single pane: the list, then the conversation with a way back', async () => {
    wide = false;
    renderInbox('/console/inbox?view=open');
    const row = await within(await findList()).findByRole('link', {
      name: /Meeting room AV not working/,
    });
    // Nothing is auto-selected on phones.
    expect(window.location.search).toBe('?view=open');
    fireEvent.click(row);
    await waitFor(() => expect(window.location.search).toBe('?view=open&ticket=LG-4790'));
    const heading = await screen.findByRole('heading', {
      level: 2,
      name: 'Meeting room AV not working',
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }));
    await waitFor(() => expect(window.location.search).toBe('?view=open'));
  });
});
