import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import { ConsoleTopBar } from './console-top-bar';
import type { ShellUser } from './types';

// The console top bar at narrow desktop widths (UI gap G13): with a fifth section link (Admin,
// for Super Admins and Team Leads) the links and the ticket search no longer fit at 1024 px, so
// the links collapse into the menu button below `xl` instead of `lg`.

vi.mock('next/navigation', () => ({ usePathname: () => '/console/queue' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/actions/locale', () => ({ setLocaleAction: vi.fn() }));
vi.mock('@/app/actions/auth', () => ({ signOutAction: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({ clearApiToken: vi.fn() }));
vi.mock('./notification-bell', () => ({ NotificationBell: () => <span data-bell="" /> }));
vi.mock('@/hooks/use-local-storage-state', () => ({
  useLocalStorageState: () => ['online', vi.fn()],
}));

function render(role: ShellUser['role']): string {
  const user = {
    name: 'Noor Al-Kaabi',
    email: 'noor@example.test',
    initials: 'NA',
    role,
  } satisfies ShellUser;
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{ common: enCommon, console: enConsole }}
      timeZone="UTC"
    >
      <ConsoleTopBar user={user} />
    </NextIntlClientProvider>,
  );
}

/** The class list of the first element whose opening tag matches `pattern`. */
function classesOf(html: string, pattern: RegExp): string[] {
  const tag = html.match(new RegExp(`<[^>]*${pattern.source}[^>]*>`))?.[0] ?? '';
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
}

describe('console top bar: section links vs the menu button', () => {
  it('collapses five links (Admin included) into the menu below xl', () => {
    for (const role of ['SUPER_ADMIN', 'TEAM_LEAD'] as const) {
      const html = render(role);
      expect(html, role).toContain('href="/admin"');
      expect(classesOf(html, /aria-label="Console"/), role).toContain('max-xl:hidden');
      expect(classesOf(html, /aria-label="Open navigation"/), role).toContain('xl:hidden');
    }
  });

  it('keeps the four agent links in the bar from lg', () => {
    const html = render('AGENT');
    expect(html).not.toContain('href="/admin"');
    expect(classesOf(html, /aria-label="Console"/)).toContain('max-lg:hidden');
    expect(classesOf(html, /aria-label="Open navigation"/)).toContain('lg:hidden');
  });
});
