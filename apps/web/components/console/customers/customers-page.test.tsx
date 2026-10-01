// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { CUSTOMERS_REFRESH_MS } from '@/lib/customers/queries';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enTickets from '@/messages/en/tickets.json';
import { createInboxWorld, type InboxWorld } from '../test-world';
import { Customers } from './customers-page';

// Customers (Phase 5 F8): the in-memory world behind the real fetchers (schema-checked).
const api = vi.hoisted(() => ({
  world: null as InboxWorld | null,
  calls: [] as string[],
  /** Makes the next N GET /customers calls fail. */
  failNext: 0,
  /** Holds GET /customers?cursor=… until resolved (to observe the loading state). */
  hold: null as Promise<void> | null,
}));
vi.mock('@/lib/api/browser', async () => {
  const { worldRequest } = await import('../test-world');
  const { ApiRequestError: Err } = await import('@/lib/api/errors');
  return {
    apiClient: {
      get: async (path: string) => {
        api.calls.push(path);
        if (path.startsWith('/customers') && path.includes('cursor=') && api.hold) {
          await api.hold;
        }
        if (path.startsWith('/customers') && api.failNext > 0) {
          api.failNext -= 1;
          throw new Err(500, 'INTERNAL', 'Boom');
        }
        return worldRequest(api.world!, 'GET', path);
      },
    },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

// next/navigation: search params follow the History API, like the App Router does.
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

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
beforeEach(() => {
  api.world = createInboxWorld({ now: Date.now() });
  api.calls = [];
  api.failNext = 0;
  api.hold = null;
  window.history.replaceState(null, '', '/console/customers');
});
afterEach(cleanup);

const MESSAGES = {
  en: { common: enCommon, console: enConsole, tickets: enTickets },
  ar: { common: arCommon, console: arConsole, tickets: arTickets },
};

const HMC = fixtureId(601);
const QNB = fixtureId(602);

function renderCustomers(url = '/console/customers', locale: 'en' | 'ar' = 'en') {
  window.history.replaceState(null, '', url);
  // The hooks decide what to retry (5xx once); the retry itself is immediate here.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <Customers />
        </div>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const table = () => screen.getByRole('table', { name: /^(Customers|العملاء)$/ });
/** Body rows (the header row holds column headers, not cells). */
const bodyRows = () =>
  within(table())
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0);
const customerCalls = () => api.calls.filter((path) => path.startsWith('/customers'));
const strip = (text: string) => text.replace(/[⁦-⁩]/g, '');

describe('Customers', () => {
  it('shows skeletons, then one row per requester with the design’s columns', async () => {
    renderCustomers();
    expect(screen.getByRole('status').textContent).toBe('Loading customers…');
    expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toBeTruthy();

    expect(await screen.findByText('4 requesters across 4 companies')).toBeTruthy();
    const headers = within(table())
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Requester', 'Client', 'Contract', 'Open', 'Total']);

    const rows = bodyRows();
    // Sorted by name (the API's order); the counts are the world's tickets per requester.
    expect(rows.map((row) => within(row).getAllByRole('cell').length)).toEqual([5, 5, 5, 5]);
    const aisha = rows.find((row) => row.textContent?.includes('Dr. Aisha Al-Kuwari'))!;
    const cells = within(aisha).getAllByRole('cell');
    // Initials skip the title (design `ini()`: "Dr. Aisha Al-Kuwari" → "AA").
    expect(cells[0]!.textContent).toBe('AADr. Aisha Al-Kuwariaisha.alkuwari@hamad.qa');
    expect(within(cells[0]!).getByText('aisha.alkuwari@hamad.qa').getAttribute('dir')).toBe('ltr');
    expect(cells[1]!.textContent).toBe('Hamad Medical Corporation');
    const pill = cells[2]!.querySelector('[data-contract]')!;
    expect(pill.textContent).toBe('AMC');
    expect(pill.className).toContain('bg-success-tint');
    // The requester card's override: 6 px radius, 12 px / 600 (design 978).
    expect(pill.className).toContain('rounded-sm');
    expect(pill.className).toContain('font-semibold');
    expect(cells[3]!.textContent).toBe('Open2');
    expect(cells[4]!.textContent).toBe('Total3');
    // Counts right-aligned and mono (inline-end in RTL); total in the muted ink.
    expect(cells[3]!.className).toContain('md:justify-end');
    expect(cells[4]!.querySelector('.font-mono')!.className).toContain('text-ink-muted');

    const omar = rows.find((row) => row.textContent?.includes('Capt. Omar Al-Naimi'))!;
    expect(within(omar).getAllByRole('cell')[0]!.textContent?.startsWith('OA')).toBe(true);
    const fatima = rows.find((row) => row.textContent?.includes('Fatima Al-Sulaiti'))!;
    expect(fatima.querySelector('[data-contract]')!.textContent).toBe('Billable');
    expect(fatima.querySelector('[data-contract]')!.className).toContain('bg-surface-sunken');
  });

  it('opens the Inbox company view from a row', async () => {
    renderCustomers();
    const link = await screen.findByRole('link', {
      name: /Dr\. Aisha Al-Kuwari.*: view .*Hamad Medical Corporation.* tickets/,
    });
    expect(link.getAttribute('href')).toBe(`/console/inbox?org=${HMC}`);
    // The link's overlay makes the whole row the click target.
    expect(link.className).toContain('after:inset-0');
    const khalid = screen.getByRole('link', { name: /Khalid Al-Mansouri/ });
    expect(khalid.getAttribute('href')).toBe(`/console/inbox?org=${QNB}`);
  });

  it('searches by name, email or company through the URL (debounced), with an empty state', async () => {
    renderCustomers();
    await screen.findByText('4 requesters across 4 companies');
    const box = screen.getByRole('searchbox', { name: 'Search customers' });

    fireEvent.change(box, { target: { value: 'q' } });
    fireEvent.change(box, { target: { value: 'qnb' } });
    // One request after the typing pause, not one per keystroke.
    await waitFor(() => expect(window.location.search).toBe('?q=qnb'));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(customerCalls().filter((path) => path.includes('search='))).toEqual([
      '/customers?search=qnb',
    ]);
    expect(bodyRows()[0]!.textContent).toContain('Khalid Al-Mansouri');
    expect(screen.getByText('1 requester across 1 company')).toBeTruthy();

    // Email and Arabic organisation names match too.
    fireEvent.change(box, { target: { value: 'ooredoo.qa' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.location.search).toBe('?q=ooredoo.qa');
    await waitFor(() => expect(bodyRows()[0]!.textContent).toContain('Fatima Al-Sulaiti'));

    fireEvent.change(box, { target: { value: 'zzz' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const empty = await screen.findByText(/No customers match/);
    expect(strip(empty.textContent!)).toBe('No customers match “zzz”.');
    expect(screen.getByText('No requesters')).toBeTruthy();

    // Escape clears the search.
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(window.location.search).toBe('');
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
  });

  it('reads the search from a shared URL and follows Back / Forward', async () => {
    renderCustomers('/console/customers?q=hamad');
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(customerCalls()[0]).toBe('/customers?search=hamad');
    const box = screen.getByRole('searchbox', { name: 'Search customers' }) as HTMLInputElement;
    expect(box.value).toBe('hamad');

    act(() => {
      window.history.pushState(null, '', '/console/customers?q=moi');
    });
    expect(box.value).toBe('moi');
    await waitFor(() => expect(bodyRows()[0]!.textContent).toContain('Capt. Omar Al-Naimi'));
  });

  it('pages with "Load more" (keyset cursor), keeping the focus (then on the first new row)', async () => {
    api.world = createInboxWorld({ now: Date.now(), pageSize: 3 });
    renderCustomers();
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    // The header counts the whole search, not the loaded page.
    expect(screen.getByText('4 requesters across 4 companies')).toBeTruthy();
    let release = () => {};
    api.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const more = screen.getByRole('button', { name: 'Load more' });
    act(() => more.focus());
    fireEvent.click(more);
    // While the page loads the button stays (so does the focus), saying so (UI gap G3).
    await waitFor(() => expect(more.textContent).toBe('Loading more customers…'));
    expect(more.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(more);
    act(() => release());
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(customerCalls()).toEqual(['/customers', '/customers?cursor=3']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const links = within(table()).getAllByRole('link');
    await waitFor(() => expect(document.activeElement).toBe(links[3]));
  });

  it('names its search landmark apart from the top bar’s, and truncates names in either script', async () => {
    renderCustomers('/console/customers', 'ar');
    // UI gap G8: two search landmarks on the page (this one and the tickets search).
    expect(screen.getByRole('search', { name: 'البحث في العملاء' })).toBeTruthy();
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    // UI gap G4: dir="auto" puts the ellipsis at the text's own end.
    const aisha = bodyRows().find((row) => row.textContent?.includes('Dr. Aisha Al-Kuwari'))!;
    const link = within(aisha).getByRole('link');
    expect(link.getAttribute('dir')).toBe('auto');
    expect(link.className).toContain('[text-align:match-parent]');
    expect(within(aisha).getByText('مؤسسة حمد الطبية').getAttribute('dir')).toBe('auto');
  });

  it('refreshes every 60 s while visible (queue:updated misses tickets assigned on other teams)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderCustomers();
      await waitFor(() => expect(bodyRows()).toHaveLength(4));
      const before = customerCalls().length;
      // Someone assigns the viewer a ticket of another team: the counts change server-side.
      act(() => vi.advanceTimersByTime(CUSTOMERS_REFRESH_MS));
      await waitFor(() => expect(customerCalls().length).toBe(before + 1));
      expect(customerCalls().at(-1)).toBe('/customers');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error with a working Retry', async () => {
    // A 5xx is retried once by the query, then the page says so.
    api.failNext = 2;
    renderCustomers();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The customers couldn’t be loaded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(bodyRows()).toHaveLength(4));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('speaks Arabic: plural summary, isolated search term, LTR emails', async () => {
    renderCustomers('/console/customers', 'ar');
    expect(await screen.findByText('4 مقدمي طلبات من 4 جهات')).toBeTruthy();
    expect(
      within(table())
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['مقدم الطلب', 'العميل', 'العقد', 'مفتوحة', 'الإجمالي']);
    // Arabic organisation names when they exist.
    expect(screen.getByText('مؤسسة حمد الطبية')).toBeTruthy();
    expect(screen.getByText('f.alsulaiti@ooredoo.qa').getAttribute('dir')).toBe('ltr');

    const box = screen.getByRole('searchbox', { name: 'البحث في العملاء' });
    fireEvent.change(box, { target: { value: 'x@y.qa' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const empty = await screen.findByText(/لا يوجد عملاء يطابقون/);
    // The Latin term keeps its own direction inside the Arabic sentence (FSI … PDI).
    expect(empty.textContent).toBe('لا يوجد عملاء يطابقون «⁨x@y.qa⁩».');
  });

  it('uses Arabic plural forms for one and two', async () => {
    renderCustomers('/console/customers?q=qnb', 'ar');
    expect(await screen.findByText('مقدم طلب واحد من جهة واحدة')).toBeTruthy();
  });
});

describe('Customers — API errors are not retried forever', () => {
  it('a 403 shows the error state once', async () => {
    api.world = createInboxWorld({ now: Date.now() });
    const spy = vi.spyOn(api.world, 'customers').mockImplementation(() => {
      throw new ApiRequestError(403, 'FORBIDDEN', 'No');
    });
    renderCustomers();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
