// @vitest-environment jsdom
import type { NotificationDto } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { makeNotification } from '@/lib/notifications/test-fixtures';
import { RealtimeClient } from '@/lib/realtime/client';
import { fakeSocketFactory, type FakeSocket } from '@/lib/realtime/fake-socket';
import { connectRealtimeToCache } from '@/lib/realtime/provider';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arErrors from '@/messages/ar/errors.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enErrors from '@/messages/en/errors.json';
import { NotificationBell } from './notification-bell';

// ── GET /me/notifications and POST /me/notifications/read over an in-memory store ──
const api = vi.hoisted(() => ({
  items: [] as NotificationDto[],
  pageSize: 20,
  calls: [] as { method: string; path: string; body?: unknown }[],
  /** Held mark-read answers (to observe the optimistic state). */
  hold: false,
  held: [] as (() => void)[],
  failRead: false,
  failList: false,
}));

vi.mock('@/lib/api/browser', () => {
  const unread = () => api.items.filter((n) => n.readAt === null).length;
  const get = async (path: string) => {
    api.calls.push({ method: 'GET', path });
    const url = new URL(path, 'http://api.test');
    if (url.pathname !== '/me/notifications') throw new Error(`unexpected GET ${path}`);
    if (api.failList) throw new ApiRequestError(503, 'SERVICE_UNAVAILABLE', 'down');
    const sorted = [...api.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? api.pageSize);
    const items = sorted.slice(start, start + Math.min(limit, api.pageSize));
    const next = start + items.length;
    return {
      items: structuredClone(items),
      nextCursor: next < sorted.length ? String(next) : null,
      unreadCount: unread(),
    };
  };
  const post = async (path: string, body: { ids?: string[]; all?: true; upTo?: string }) => {
    api.calls.push({ method: 'POST', path, body });
    if (path !== '/me/notifications/read') throw new Error(`unexpected POST ${path}`);
    if (api.hold) await new Promise<void>((resolve) => api.held.push(resolve));
    if (api.failRead) throw new ApiRequestError(503, 'SERVICE_UNAVAILABLE', 'down');
    let updated = 0;
    for (const n of api.items) {
      const inAll = body.all && (!body.upTo || n.createdAt <= body.upTo);
      if (n.readAt === null && (inAll || body.ids?.includes(n.id))) {
        n.readAt = '2026-09-23T12:30:00.000Z';
        updated += 1;
      }
    }
    return { updated, unreadCount: unread() };
  };
  return {
    apiClient: { get, post },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

// Next's Link needs the App Router; a plain anchor is enough here.
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        event.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// The tab's realtime client, driven by a fake socket.
const rt = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/realtime/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/provider')>()),
  useRealtimeClient: () => rt.client,
}));

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
});

// Unicode isolates (lib/format): first-strong for names, left-to-right for ticket numbers.
const FSI = String.fromCharCode(0x2068);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

const NOW = new Date('2026-09-23T12:05:00.000Z');
const MESSAGES = {
  en: { common: enCommon, console: enConsole, errors: enErrors },
  ar: { common: arCommon, console: arConsole, errors: arErrors },
};

let socket: FakeSocket;
let disconnectCache: () => void;

beforeEach(() => {
  api.items = [];
  api.pageSize = 20;
  api.calls = [];
  api.hold = false;
  api.held = [];
  api.failRead = false;
  api.failList = false;
  toast.error.mockReset();
});
afterEach(() => {
  disconnectCache?.();
  cleanup();
});

function renderBell(locale: 'en' | 'ar' = 'en') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { factory, sockets } = fakeSocketFactory();
  const client = new RealtimeClient({
    url: 'http://api.test',
    getToken: async () => 'token',
    createSocket: factory,
  });
  rt.client = client;
  disconnectCache = connectRealtimeToCache(client, queryClient);
  client.start();
  socket = sockets[0] as FakeSocket;
  socket.accept();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        timeZone="Asia/Qatar"
        now={NOW}
        messages={MESSAGES[locale]}
      >
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <NotificationBell />
        </div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const bell = (name: string | RegExp = /^Notifications/) => screen.getByRole('button', { name });
const badge = () => document.querySelector('[data-slot="unread-badge"]');

async function openPanel() {
  fireEvent.click(bell());
  return screen.findByRole('dialog', { name: 'Notifications' });
}

function seed(count: number, overrides: (n: number) => Partial<NotificationDto> = () => ({})) {
  api.items = Array.from({ length: count }, (_, i) => makeNotification(i + 1, overrides(i + 1)));
}

describe('NotificationBell', () => {
  it('names the button with the exact unread count and caps the badge at 9+', async () => {
    seed(12);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 12 unread')).toBeTruthy());
    expect(badge()?.textContent).toBe('9+');
    expect(badge()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows no badge and a plain name when everything is read', async () => {
    seed(2, () => ({ readAt: '2026-09-23T11:00:00.000Z' }));
    renderBell();
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await waitFor(() => expect(bell('Notifications')).toBeTruthy());
    expect(badge()).toBeNull();
  });

  it('lists notifications newest first, worded from type + data, linking to the ticket', async () => {
    api.items = [
      makeNotification(3, { type: 'SLA_BREACHED', data: { target: 'FIRST_REPLY' } }),
      makeNotification(1),
      makeNotification(2, {
        type: 'P1_ESCALATED',
        ticketNumber: 4830,
        data: { step: 2, subject: 'SOC alert' },
      }),
    ];
    renderBell();
    await waitFor(() => expect(bell('Notifications, 3 unread')).toBeTruthy());
    const panel = await openPanel();
    const links = within(panel).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/console/inbox?ticket=LG-4821',
      '/console/inbox?ticket=LG-4830',
      '/console/inbox?ticket=LG-4821',
    ]);
    // Names are first-strong isolated (FSI … PDI).
    expect(links[0]?.textContent).toContain(
      `Unread: ${FSI}Dr. Aisha Al-Kuwari${PDI} replied on LG-4821`,
    );
    expect(links[0]?.textContent).toContain('Firewall blocking the VPN');
    expect(links[0]?.textContent).toContain('6m ago');
    expect(links[1]?.textContent).toContain('P1 LG-4830 escalated · step 2');
    expect(links[2]?.textContent).toContain('First-reply SLA breached on LG-4821');
    // The ticket number is isolated left-to-right.
    const ref = links[0]?.querySelector('bdi[dir="ltr"]');
    expect(ref?.textContent).toBe('LG-4821');
    // Focus starts on the newest notification.
    await waitFor(() => expect(document.activeElement).toBe(links[0]));
  });

  it('marks one read optimistically, then all, and follows a link (marking it read)', async () => {
    seed(3);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 3 unread')).toBeTruthy());
    const panel = await openPanel();
    api.hold = true;

    const markOne = within(panel).getAllByRole('button', { name: 'Mark as read' })[0]!;
    fireEvent.click(markOne);
    // Before the API answers: one fewer unread, the item lost its unread state.
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());
    expect(panel.querySelectorAll('li[data-unread]')).toHaveLength(2);
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      body: { ids: [makeNotification(1).id] },
    });
    await act(async () => api.held.splice(0).forEach((resolve) => resolve()));

    fireEvent.click(within(panel).getByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(bell('Notifications')).toBeTruthy());
    expect(badge()).toBeNull();
    // Up to the newest notification shown: one arriving meanwhile stays unread.
    const newest = [...api.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    expect(api.calls.at(-1)).toMatchObject({ body: { all: true, upTo: newest.createdAt } });
    await act(async () => api.held.splice(0).forEach((resolve) => resolve()));
    expect(
      within(panel).getByRole('button', { name: 'Mark all as read' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('keeps the keyboard focus in the panel after mark one, mark all and show older', async () => {
    api.pageSize = 2;
    seed(3);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 3 unread')).toBeTruthy());
    const panel = await openPanel();

    // The unread dot keeps a colour in forced-colors mode (backgrounds are dropped there).
    expect(panel.querySelector('li[data-unread] span[aria-hidden]')?.className).toContain(
      'forced-colors:bg-[CanvasText]',
    );
    // "Mark as read" disappears with the unread state: its item takes the focus.
    const markOne = within(panel).getAllByRole('button', { name: 'Mark as read' })[0]!;
    markOne.focus();
    fireEvent.click(markOne);
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());
    expect(document.activeElement).toBe(within(panel).getAllByRole('link')[0]);

    // "Mark all as read" stays focusable (aria-disabled), and a second press does nothing.
    const all = within(panel).getByRole('button', { name: 'Mark all as read' });
    all.focus();
    fireEvent.click(all);
    await waitFor(() => expect(bell('Notifications')).toBeTruthy());
    expect(document.activeElement).toBe(all);
    expect(all.getAttribute('aria-disabled')).toBe('true');
    const posts = api.calls.filter((c) => c.method === 'POST').length;
    fireEvent.click(all);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);

    // "Show older" goes away with the last page: the first new item takes the focus.
    const more = within(panel).getByRole('button', { name: 'Show older notifications' });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(within(panel).getAllByRole('link')).toHaveLength(3));
    expect(document.activeElement).toBe(within(panel).getAllByRole('link')[2]);
  });

  it('following an unread item marks it read and closes the panel', async () => {
    seed(2);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());
    const panel = await openPanel();
    fireEvent.click(within(panel).getAllByRole('link')[1]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.at(-1)).toMatchObject({ body: { ids: [makeNotification(2).id] } });
    await waitFor(() => expect(bell('Notifications, 1 unread')).toBeTruthy());
  });

  it('reloads and explains when marking read fails', async () => {
    seed(2);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());
    const panel = await openPanel();
    api.failRead = true;
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Mark as read' })[0]!);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Couldn’t mark notifications as read.'),
      ),
    );
    // The server's state wins again: still two unread.
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());
    expect(api.calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('inserts notification:new live at the top and announces it once', async () => {
    seed(1);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 1 unread')).toBeTruthy());
    const pushed = makeNotification(0, {
      id: fixtureId(2999),
      type: 'P1_CREATED',
      ticketNumber: 4830,
      data: { priority: 'P1', subject: 'Suspected intrusion' },
      createdAt: '2026-09-23T12:04:00.000Z',
    });
    act(() => socket.receive('notification:new', { notification: pushed, unreadCount: 2 }));
    act(() => socket.receive('notification:new', { notification: pushed, unreadCount: 2 }));
    await waitFor(() => expect(bell('Notifications, 2 unread')).toBeTruthy());

    const status = screen.getByRole('status');
    expect(status.textContent).toBe(`New notification: New P1 ticket ${LRI}LG-4830${PDI}`);
    expect(status.children).toHaveLength(1);

    // Another one replaces the announcement; a late repeat of the first is not read out again.
    const second = makeNotification(0, {
      id: fixtureId(2998),
      type: 'SLA_AT_RISK',
      data: { target: 'FIRST_REPLY' },
      createdAt: '2026-09-23T12:04:30.000Z',
    });
    act(() => socket.receive('notification:new', { notification: second, unreadCount: 3 }));
    act(() => socket.receive('notification:new', { notification: pushed, unreadCount: 3 }));
    await waitFor(() => expect(bell('Notifications, 3 unread')).toBeTruthy());
    expect(status.textContent).toBe(
      `New notification: First-reply SLA at risk on ${LRI}LG-4821${PDI}`,
    );

    const panel = await openPanel();
    const links = within(panel).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]?.textContent).toContain('First-reply SLA at risk on LG-4821');
    expect(links[1]?.textContent).toContain('New P1 ticket LG-4830');
    // No refetch was needed.
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('pages older notifications with the cursor', async () => {
    api.pageSize = 2;
    seed(3);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 3 unread')).toBeTruthy());
    const panel = await openPanel();
    expect(within(panel).getAllByRole('link')).toHaveLength(2);
    fireEvent.click(within(panel).getByRole('button', { name: 'Show older notifications' }));
    await waitFor(() => expect(within(panel).getAllByRole('link')).toHaveLength(3));
    expect(api.calls.at(-1)?.path).toContain('cursor=2');
    expect(within(panel).queryByRole('button', { name: 'Show older notifications' })).toBeNull();
  });

  it('closes on Escape and gives the focus back to the bell', async () => {
    seed(1);
    renderBell();
    await waitFor(() => expect(bell('Notifications, 1 unread')).toBeTruthy());
    const panel = await openPanel();
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(bell());
  });

  it('says when there is nothing, and offers a retry when loading fails', async () => {
    renderBell();
    await waitFor(() => expect(api.calls).toHaveLength(1));
    const panel = await openPanel();
    expect(within(panel).getByText('No notifications yet.')).toBeTruthy();

    cleanup();
    disconnectCache();
    api.failList = true;
    renderBell();
    const failed = await openPanel();
    // After the hook's one retry.
    expect(
      await within(failed).findByText('Notifications couldn’t be loaded.', {}, { timeout: 4000 }),
    ).toBeTruthy();
    api.failList = false;
    seed(1);
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(await within(failed).findAllByRole('link')).toHaveLength(1);
  });

  it('speaks Arabic, keeping the ticket number left-to-right', async () => {
    seed(3, (n) =>
      n === 1
        ? { type: 'P1_ACKNOWLEDGED', data: { actor: { id: fixtureId(801), name: 'Maya Ruiz' } } }
        : {},
    );
    renderBell('ar');
    await waitFor(() => expect(bell('الإشعارات، 3 غير مقروءة')).toBeTruthy());
    fireEvent.click(bell(/^الإشعارات/));
    const panel = await screen.findByRole('dialog', { name: 'الإشعارات' });
    const first = within(panel).getAllByRole('link')[0]!;
    expect(first.textContent).toContain('أكّد');
    expect(first.textContent).toContain('استلام تذكرة P1');
    expect(first.querySelector('bdi[dir="ltr"]')?.textContent).toBe('LG-4821');
    expect(within(panel).getByRole('button', { name: 'تعليم الكل كمقروء' })).toBeTruthy();
  });
});
