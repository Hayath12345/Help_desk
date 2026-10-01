// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureId } from '@/lib/tickets/test-fixtures';
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
import { createInboxWorld, type InboxWorld } from './test-world';

// The Inbox company view (Phase 5 F9): `?org=` lists every ticket of one client organisation (any
// status), titled with its name, with a "Clear" chip; the requester card links to it.

const api = vi.hoisted(() => ({
  world: null as InboxWorld | null,
  calls: [] as { method: string; path: string }[],
}));
vi.mock('@/lib/api/browser', async () => {
  const { worldRequest } = await import('./test-world');
  const call = (method: 'GET' | 'POST' | 'PATCH') => async (path: string, body?: unknown) => {
    api.calls.push({ method, path });
    return worldRequest(api.world!, method, path, body);
  };
  return {
    apiClient: { get: call('GET'), post: call('POST'), patch: call('PATCH') },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
    matches: query.includes('min-width'),
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

function renderInbox(url: string, locale: 'en' | 'ar' = 'en') {
  window.history.replaceState(null, '', url);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={api.world!.viewer}>
          <Inbox />
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const HMC = fixtureId(601);
const QNB = fixtureId(602);
const slow = { timeout: 5_000 };
const list = () =>
  screen.getByRole('list', { name: /^(Tickets in this view|التذاكر في طريقة العرض هذه)$/ });
const refs = () =>
  within(list())
    .getAllByRole('link')
    .map((a) => a.getAttribute('data-ticket-ref'));
const listTitle = () => document.getElementById('inbox-list-title')!;
const ticketCalls = () =>
  api.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/tickets?')).map((c) => c.path);

describe('Inbox company view (Phase 5 F9)', () => {
  it('lists every ticket of the company from a shared URL, titled with its name', async () => {
    renderInbox(`/console/inbox?org=${HMC}`);
    await waitFor(() => expect(listTitle().textContent).toBe('Hamad Medical Corporation3'), slow);
    // All statuses: the solved LG-4752 is listed too (the views never mix them).
    await waitFor(() => expect(refs()).toHaveLength(3), slow);
    expect([...refs()].sort()).toEqual(['LG-4752', 'LG-4771', 'LG-4829']);
    // The company filter reaches the API, without a view.
    const first = new URL(ticketCalls()[0]!, 'http://x').searchParams;
    expect(first.get('orgId')).toBe(HMC);
    expect(first.get('view')).toBeNull();
    expect(api.calls.some((c) => c.path === `/customers/orgs/${HMC}`)).toBe(true);

    // No view or team is "current" while the company view is on; their counts are unchanged.
    const views = screen.getByRole('navigation', { name: 'Views' });
    expect(within(views).queryByRole('link', { current: 'page' })).toBeNull();
    expect(within(views).getByRole('link', { name: /My queue\s*1/ })).toBeTruthy();
    expect(within(views).getByRole('link', { name: /All open\s*6/ })).toBeTruthy();

    // The narrow layout's select names the company.
    expect(screen.getByRole('combobox', { name: 'Choose a view' }).textContent).toBe(
      'Hamad Medical Corporation',
    );
    expect(screen.getByText('All of this company’s tickets, in any status')).toBeTruthy();
  });

  it('the Clear chip returns to the view underneath', async () => {
    renderInbox(`/console/inbox?view=open&org=${HMC}`);
    await waitFor(() => expect(refs()).toHaveLength(3), slow);
    const clear = screen.getByRole('link', { name: 'Clear the company filter' });
    expect(clear.textContent).toBe('Clear');
    expect(clear.getAttribute('href')).toBe('/console/inbox?view=open');

    fireEvent.click(clear);
    await waitFor(() => expect(window.location.search).toMatch(/^\?view=open(&|$)/), slow);
    expect(window.location.search).not.toContain('org=');
    await waitFor(() => expect(refs()).toHaveLength(6), slow);
    expect(listTitle().textContent).toBe('All open6');
    expect(screen.queryByRole('link', { name: 'Clear the company filter' })).toBeNull();
    // Focus stays on the list (the chip is gone), not lost to the page.
    await waitFor(() => expect(document.activeElement).toBe(listTitle()));
  });

  it('below 1180 px the Clear chip hands the focus to the view picker (the heading is sr-only)', async () => {
    const wide = window.matchMedia;
    // Narrow: no min-width query matches (the list heading is only for screen readers there).
    window.matchMedia = ((query: string) => ({
      ...wide(query),
      matches: false,
    })) as typeof window.matchMedia;
    try {
      renderInbox(`/console/inbox?view=open&org=${HMC}`);
      await waitFor(() => expect(refs()).toHaveLength(3), slow);
      fireEvent.click(screen.getByRole('link', { name: 'Clear the company filter' }));
      await waitFor(() => expect(refs()).toHaveLength(6), slow);
      // UI gap G7: a visible focus target, the view picker that stands in for the heading.
      const picker = screen.getByRole('combobox', { name: 'Choose a view' });
      await waitFor(() => expect(document.activeElement).toBe(picker));
      expect(picker.textContent).toBe('All open (6)');
    } finally {
      window.matchMedia = wide;
    }
  });

  it('the views and teams still work from the company view', async () => {
    renderInbox(`/console/inbox?org=${HMC}`);
    await waitFor(() => expect(refs()).toHaveLength(3), slow);
    fireEvent.click(screen.getByRole('link', { name: /^P1 critical/ }));
    await waitFor(() => expect(window.location.search).toMatch(/^\?view=p1/), slow);
    expect(window.location.search).not.toContain('org=');
    await waitFor(() => expect(refs()).toHaveLength(3), slow);
    expect(listTitle().textContent).toBe('P1 critical3');
  });

  it('combines with the search', async () => {
    renderInbox(`/console/inbox?org=${HMC}&q=nvr`);
    await waitFor(() => expect(refs()).toEqual(['LG-4771']), slow);
    const params = new URL(ticketCalls()[0]!, 'http://x').searchParams;
    expect(params.get('orgId')).toBe(HMC);
    expect(params.get('search')).toBe('nvr');
  });

  it('an unknown company keeps a generic title and an empty list', async () => {
    const unknown = fixtureId(699);
    renderInbox(`/console/inbox?org=${unknown}`);
    expect(await screen.findByText('Nothing here', {}, slow)).toBeTruthy();
    expect(listTitle().textContent).toBe('Company0');
  });

  it('is titled with the Arabic name in Arabic', async () => {
    renderInbox(`/console/inbox?org=${HMC}`, 'ar');
    await waitFor(() => expect(listTitle().textContent).toBe('مؤسسة حمد الطبية3'), slow);
    expect(screen.getByRole('link', { name: 'مسح تصفية الجهة' }).textContent).toBe('مسح');
  });
});

describe('Requester card → company view', () => {
  it('"N from this client" opens the company view in place, keeping the view for Clear', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4817');
    const details = await screen.findByRole('complementary', { name: 'Ticket details' }, slow);
    const link = await within(details).findByRole('link', { name: '1 from this client' }, slow);
    expect(link.getAttribute('href')).toBe(`/console/inbox?org=${QNB}`);

    fireEvent.click(link);
    await waitFor(
      () => expect(window.location.search).toMatch(new RegExp(`^\\?view=open&org=${QNB}`)),
      slow,
    );
    await waitFor(() => expect(listTitle().textContent).toBe('QNB2'), slow);
    // Rows of the previous list fade out (exit animation) before they leave the DOM.
    await waitFor(() => expect([...refs()].sort()).toEqual(['LG-4809', 'LG-4817']), slow);

    // The link leaves with the ticket panel: the focus moves to the list (UI gap G6).
    await waitFor(() => expect(document.activeElement).toBe(listTitle()));

    fireEvent.click(screen.getByRole('link', { name: 'Clear the company filter' }));
    await waitFor(() => expect(refs()).toHaveLength(6), slow);
    expect(listTitle().textContent).toBe('All open6');
  });

  it('reads "View client" when the company has no other ticket', async () => {
    renderInbox('/console/inbox?view=open&ticket=LG-4821');
    const details = await screen.findByRole('complementary', { name: 'Ticket details' }, slow);
    const link = await within(details).findByRole('link', { name: 'View client' }, slow);
    expect(link.getAttribute('href')).toBe(`/console/inbox?org=${fixtureId(603)}`);
    // Keyboard use: activated with the focus on it, it opens the company view in place and the
    // focus goes on to the list, never to the page (UI gaps G6, G14).
    act(() => link.focus());
    fireEvent.click(link);
    await waitFor(() => expect(window.location.search).toContain(`org=${fixtureId(603)}`), slow);
    await waitFor(() => expect(refs()).toEqual(['LG-4821']), slow);
    await waitFor(() => expect(document.activeElement).toBe(listTitle()));
    expect(link.isConnected).toBe(false);
  });
});
