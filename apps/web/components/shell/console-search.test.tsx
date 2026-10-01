// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enConsole from '@/messages/en/console.json';
import { ConsoleSearchBox, ConsoleSearchProvider } from './console-search';

const router = vi.hoisted(() => ({ push: vi.fn() }));

// next/navigation that follows the History API (as the App Router does for pushState).
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
    return () => listeners.delete(listener);
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

beforeEach(() => router.push.mockReset());
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function renderSearch(url: string) {
  window.history.replaceState(null, '', url);
  render(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ console: enConsole }}>
      <ConsoleSearchProvider>
        <ConsoleSearchBox />
      </ConsoleSearchProvider>
    </NextIntlClientProvider>,
  );
  return screen.getByRole('searchbox', { name: 'Search tickets' }) as HTMLInputElement;
}

describe('Console search', () => {
  it('shows the inbox ?q= and follows URL changes (Back, links)', () => {
    const box = renderSearch('/console/inbox?view=open&q=nvr');
    expect(box.value).toBe('nvr');
    act(() => window.history.pushState(null, '', '/console/inbox?view=open&q=turnstile'));
    expect(box.value).toBe('turnstile');
    act(() => window.history.pushState(null, '', '/console/inbox'));
    expect(box.value).toBe('');
  });

  it('updates ?q= after a typing pause and drops the open ticket', async () => {
    const box = renderSearch('/console/inbox?view=risk&ticket=LG-4817');
    fireEvent.change(box, { target: { value: 'card reader' } });
    expect(box.value).toBe('card reader');
    expect(window.location.search).toBe('?view=risk&ticket=LG-4817');
    await waitFor(() => expect(window.location.search).toBe('?view=risk&q=card+reader'));
    expect(box.value).toBe('card reader');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('applies at once on Enter and clears with Escape or ×', () => {
    const box = renderSearch('/console/inbox');
    fireEvent.change(box, { target: { value: 'LG-4771' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(window.location.search).toBe('?q=LG-4771');

    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(window.location.search).toBe('');

    fireEvent.change(box, { target: { value: 'fw' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(window.location.search).toBe('');
    expect(document.activeElement).toBe(box);
  });

  it('filters the Team queue in place: its ?q= (tab and filters kept), never the inbox', async () => {
    const box = renderSearch('/console/queue?tab=unassigned&priority=P2&q=nvr');
    expect(box.value).toBe('nvr');
    fireEvent.change(box, { target: { value: ' turnstile ' } });
    await waitFor(() =>
      expect(window.location.search).toBe('?tab=unassigned&priority=P2&q=turnstile'),
    );
    expect(window.location.pathname).toBe('/console/queue');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(window.location.search).toBe('?tab=unassigned&priority=P2');
    // Back / links update the box, as on the inbox.
    act(() => window.history.pushState(null, '', '/console/queue?q=cctv'));
    expect(box.value).toBe('cctv');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('searches the inbox from the other console pages', async () => {
    const box = renderSearch('/console/customers');
    fireEvent.change(box, { target: { value: ' hamad ' } });
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith('/console/inbox?view=open&q=hamad'),
    );
    // An empty search does not navigate anywhere.
    router.push.mockReset();
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(router.push).not.toHaveBeenCalled();
  });
});
