// @vitest-environment jsdom
import type { ReportsSummary } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import type { Viewer } from '@/lib/tickets/types';
import { ViewerProvider } from '@/lib/tickets/viewer';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arTickets from '@/messages/ar/tickets.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enTickets from '@/messages/en/tickets.json';
import { WORLD_CONFIG, WORLD_PEOPLE, createInboxWorld, type InboxWorld } from '../test-world';
import { Reports } from './reports-page';

// Reports (Phase 5 F10–F12): the in-memory world behind the real fetcher (schema-checked); a test
// can replace the summary (`api.summary`) to pin exact numbers.
const api = vi.hoisted(() => ({
  world: null as InboxWorld | null,
  calls: [] as string[],
  summary: null as ((period: string) => unknown) | null,
  failNext: 0,
}));
vi.mock('@/lib/api/browser', async () => {
  const { worldRequest } = await import('../test-world');
  const { ApiRequestError: Err } = await import('@/lib/api/errors');
  return {
    apiClient: {
      get: async (path: string) => {
        api.calls.push(path);
        if (path.startsWith('/reports/summary')) {
          if (api.failNext > 0) {
            api.failNext -= 1;
            throw new Err(500, 'INTERNAL', 'Boom');
          }
          const period = new URL(path, 'http://x').searchParams.get('period') ?? '30d';
          if (api.summary) return api.summary(period);
        }
        return worldRequest(api.world!, 'GET', path);
      },
    },
    getApiToken: vi.fn(async () => 'token'),
    clearApiToken: vi.fn(),
  };
});

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
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});
beforeEach(() => {
  api.world = createInboxWorld({ now: Date.now() });
  api.calls = [];
  api.summary = null;
  api.failNext = 0;
  window.history.replaceState(null, '', '/console/reports');
});
afterEach(cleanup);

const MESSAGES = {
  en: { common: enCommon, console: enConsole, tickets: enTickets },
  ar: { common: arCommon, console: arConsole, tickets: arTickets },
};

const SUPER_ADMIN: Viewer = { id: fixtureId(809), name: 'Noor Al-Kaabi', role: 'SUPER_ADMIN' };

function renderReports(
  url = '/console/reports',
  options: { locale?: 'en' | 'ar'; viewer?: Viewer } = {},
) {
  const locale = options.locale ?? 'en';
  window.history.replaceState(null, '', url);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale={locale} timeZone="Asia/Qatar" messages={MESSAGES[locale]}>
        <ViewerProvider viewer={options.viewer ?? WORLD_PEOPLE.maya}>
          <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
            <Reports />
          </div>
        </ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const tile = (key: string) => document.querySelector<HTMLElement>(`[data-tile="${key}"]`)!;
const valueOf = (key: string) => tile(key).querySelector<HTMLElement>('[data-value]')!;
const reportCalls = () => api.calls.filter((path) => path.startsWith('/reports'));

const category = (id: number, key: string, labelEn: string, labelAr: string, isActive = true) => ({
  id: fixtureId(id),
  key,
  labelEn,
  labelAr,
  icon: 'circle',
  isActive,
});

/** A fixed answer (exact numbers), for the period asked. */
function pinned(overrides: Partial<ReportsSummary['tiles']> = {}, byCategory?: unknown[]) {
  return (period: string): ReportsSummary => ({
    period: period as ReportsSummary['period'],
    timeZone: 'Asia/Qatar',
    from: '2026-09-01T00:00:00+03:00',
    generatedAt: '2026-09-30T12:00:00+03:00',
    tiles: {
      open: 12,
      p1Open: 0,
      breached: 0,
      unassigned: 5,
      solved: period === '7d' ? 4 : 31,
      firstReply: { averageMinutes: 65, tickets: 23 },
      ...overrides,
    },
    byCategory: (byCategory as ReportsSummary['byCategory']) ?? [
      { category: category(201, 'cyber', 'Cybersecurity / SOC', 'الأمن السيبراني'), open: 8 },
      { category: category(202, 'cctv', 'CCTV & Video Surveillance', 'كاميرات المراقبة'), open: 4 },
      { category: category(203, 'other', 'Other', 'أخرى'), open: 0 },
    ],
  });
}

describe('Reports', () => {
  it('shows skeletons, then the tiles of the world’s tickets with the design’s colours', async () => {
    renderReports();
    expect(screen.getByRole('status').textContent).toBe('Loading reports…');
    await waitFor(() => expect(tile('open')).toBeTruthy());

    // World: 6 open (7 tickets, 1 solved), 3 P1, 1 overdue (LG-4771), 2 unassigned, 1 solved.
    expect(valueOf('open').textContent).toBe('6');
    expect(valueOf('p1Open').textContent).toBe('3');
    expect(valueOf('breached').textContent).toBe('1');
    expect(valueOf('unassigned').textContent).toBe('2');
    expect(valueOf('solved').textContent).toBe('1');
    // Labels are the design's kickers.
    expect(within(tile('breached')).getByText('SLA breached')).toBeTruthy();
    // P1 red (danger) and breached red (overdue) when > 0; solved green; the rest ink.
    expect(valueOf('p1Open').className).toContain('text-danger');
    expect(valueOf('breached').className).toContain('text-overdue');
    expect(valueOf('solved').className).toContain('text-success');
    expect(valueOf('open').className).toContain('text-ink');
    expect(reportCalls()).toEqual(['/reports/summary?period=30d']);
  });

  it('links every tile to its list, except the average', async () => {
    renderReports();
    await waitFor(() => expect(tile('open')).toBeTruthy());
    const href = (key: string) => tile(key).getAttribute('href');
    expect(href('open')).toBe('/console/queue');
    expect(href('p1Open')).toBe('/console/inbox?view=p1');
    expect(href('breached')).toBe('/console/inbox?view=risk');
    expect(href('unassigned')).toBe('/console/queue?tab=unassigned');
    expect(href('solved')).toBe('/console/inbox?view=solved');
    expect(tile('firstReply').tagName).toBe('DIV');
    // The tile's link text is its label and value.
    expect(screen.getByRole('link', { name: 'Unassigned 2' })).toBe(tile('unassigned'));
  });

  it('keeps zero counts in ink and formats the average first reply with its ticket count', async () => {
    api.summary = pinned();
    renderReports();
    await waitFor(() => expect(valueOf('open').textContent).toBe('12'));
    expect(valueOf('p1Open').textContent).toBe('0');
    expect(valueOf('p1Open').className).not.toContain('text-danger');
    expect(valueOf('breached').className).not.toContain('text-overdue');
    expect(valueOf('firstReply').textContent).toBe('1h 05m');
    expect(within(tile('firstReply')).getByText('23 tickets · Last 30 days')).toBeTruthy();
    expect(within(tile('solved')).getByText('Last 30 days')).toBeTruthy();
  });

  it('shows "—" when no ticket was first replied in the period', async () => {
    api.summary = pinned({ firstReply: { averageMinutes: null, tickets: 0 } });
    renderReports();
    await waitFor(() => expect(tile('firstReply')).toBeTruthy());
    const value = valueOf('firstReply');
    expect(value.textContent).toBe('—No data');
    expect(value.querySelector('[aria-hidden="true"]')!.textContent).toBe('—');
    expect(within(tile('firstReply')).getByText('No first replies · Last 30 days')).toBeTruthy();
  });

  it('switches the period through the URL; Back returns to the previous one', async () => {
    api.summary = pinned();
    renderReports();
    await waitFor(() => expect(valueOf('solved').textContent).toBe('31'));
    const picker = screen.getByRole('radiogroup', { name: 'Period' });
    expect(
      within(picker)
        .getAllByRole('radio')
        .map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]),
    ).toEqual([
      ['Last 7 days', 'false'],
      ['Last 30 days', 'true'],
      ['Last 90 days', 'false'],
    ]);

    fireEvent.click(within(picker).getByRole('radio', { name: 'Last 7 days' }));
    expect(window.location.search).toBe('?period=7d');
    await waitFor(() => expect(valueOf('solved').textContent).toBe('4'));
    expect(reportCalls()).toEqual(['/reports/summary?period=30d', '/reports/summary?period=7d']);
    expect(within(tile('solved')).getByText('Last 7 days')).toBeTruthy();

    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(''));
    await waitFor(() => expect(valueOf('solved').textContent).toBe('31'));
  });

  it('reads the period from a shared URL (unknown values fall back to 30 days)', async () => {
    renderReports('/console/reports?period=90d');
    await waitFor(() => expect(tile('open')).toBeTruthy());
    expect(reportCalls()).toEqual(['/reports/summary?period=90d']);
    cleanup();
    api.calls = [];
    renderReports('/console/reports?period=1y');
    await waitFor(() => expect(tile('open')).toBeTruthy());
    expect(reportCalls()).toEqual(['/reports/summary?period=30d']);
  });

  it('draws the category bars relative to the largest, zeros and archived categories included', async () => {
    api.summary = pinned({}, [
      { category: category(201, 'cyber', 'Cybersecurity / SOC', 'الأمن السيبراني'), open: 8 },
      { category: category(202, 'cctv', 'CCTV & Video Surveillance', 'كاميرات المراقبة'), open: 2 },
      { category: category(203, 'other', 'Other', 'أخرى'), open: 0 },
      { category: category(204, 'legacy', 'Legacy', 'قديمة', false), open: 4 },
    ]);
    renderReports();
    const list = await screen.findByRole('list', { name: 'Open tickets by category' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Cybersecurity / SOC8',
      'CCTV & Video Surveillance2',
      'Other0',
      'Legacy (archived)4',
    ]);
    const width = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-bar]')!.style.width;
    expect(rows.map(width)).toEqual(['100%', '25%', '0%', '50%']);
    expect(rows[3]!.hasAttribute('data-archived')).toBe(true);
    // The bar track: surface-sunken, 8 px, 4 px radius; the fill is brand.
    const track = rows[0]!.querySelector('[data-bar]')!.parentElement!;
    expect(track.className).toContain('bg-surface-sunken');
    expect(track.className).toContain('h-2');
    expect(track.className).toContain('rounded-[4px]');
    expect(track.getAttribute('aria-hidden')).toBe('true');
    expect(rows[0]!.querySelector('[data-bar]')!.className).toContain('bg-brand');
  });

  it('lists the world’s categories in admin order with their open counts', async () => {
    renderReports();
    const list = await screen.findByRole('list', { name: 'Open tickets by category' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-category'))).toEqual(
      WORLD_CONFIG.categories.map((c) => c.key),
    );
    const count = (key: string) =>
      rows.find((row) => row.getAttribute('data-category') === key)!.lastElementChild!.textContent;
    expect(count('cyber')).toBe('1');
    expect(count('cctv')).toBe('1');
  });

  it('says whose tickets the numbers cover', async () => {
    renderReports();
    expect(await screen.findByText('Your teams')).toBeTruthy();
    cleanup();
    renderReports('/console/reports', { viewer: SUPER_ADMIN });
    expect(await screen.findByText('All teams')).toBeTruthy();
  });

  it('shows an error with a working Retry', async () => {
    api.failNext = 2;
    renderReports();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The reports couldn’t be loaded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(valueOf('open').textContent).toBe('6'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not retry a refused request', async () => {
    let calls = 0;
    api.summary = () => {
      calls += 1;
      throw new ApiRequestError(403, 'FORBIDDEN', 'No');
    };
    renderReports();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(calls).toBe(1);
  });

  it('speaks Arabic', async () => {
    api.summary = pinned({ firstReply: { averageMinutes: 42, tickets: 3 } }, [
      { category: category(204, 'legacy', 'Legacy', 'قديمة', false), open: 1 },
    ]);
    renderReports('/console/reports', { locale: 'ar' });
    await waitFor(() => expect(tile('open')).toBeTruthy());
    expect(within(tile('firstReply')).getByText('متوسط وقت الرد الأول')).toBeTruthy();
    expect(within(tile('firstReply')).getByText('3 تذاكر · آخر 30 يومًا')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'الفترة' })).toBeTruthy();
    expect(screen.getByText('فرقك')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'التذاكر المفتوحة حسب الفئة' });
    expect(within(list).getByRole('listitem').textContent).toBe('قديمة (مؤرشفة)1');
  });
});
