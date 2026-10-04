// @vitest-environment jsdom
import { ADMIN_SECTIONS } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminOverview } from '@/app/(admin)/admin/_components/admin-overview';
import { AdminNav } from '@/components/shell/admin-nav';
import { loadMessages } from '@/i18n/messages';
import arAdmin from '@/messages/ar/admin.json';
import enAdmin from '@/messages/en/admin.json';
import enCommon from '@/messages/en/common.json';
import { stubBrowserApis } from './kit/kit-test-utils';
import { ADMIN_SECTION_COMPONENTS } from './sections/registry';

const nav = vi.hoisted(() => ({ pathname: '/admin/teams' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function renderIn(ui: React.ReactElement, locale: 'en' | 'ar' = 'en') {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={{ admin: locale === 'ar' ? arAdmin : enAdmin, common: enCommon }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('admin navigation (E8)', () => {
  it('groups the 14 sections under small headings for super admins', () => {
    renderIn(<AdminNav role="SUPER_ADMIN" />);
    const navigation = screen.getByRole('navigation', { name: 'Admin sections' });
    expect(
      within(navigation)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Ticket setup', 'SLA & escalation', 'People & clients', 'Communication', 'System']);
    const people = within(navigation).getByRole('list', { name: 'People & clients' });
    expect(
      within(people)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Teams & members', 'Staff', 'Skills', 'Clients & sites']);
    const system = within(navigation).getByRole('list', { name: 'System' });
    expect(
      within(system)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/admin/settings', '/admin/audit-log']);
    // Back to console + Overview + 14 sections; one of them is the current page.
    expect(within(navigation).getAllByRole('link')).toHaveLength(16);
    expect(within(navigation).getByRole('link', { current: 'page' }).textContent).toBe(
      'Teams & members',
    );
  });

  it('keeps the visually hidden group headings inside the phone strip (no page-wide overflow)', () => {
    renderIn(<AdminNav role="SUPER_ADMIN" />);
    const heading = screen.getByRole('heading', { name: 'System' });
    expect(heading.className).toContain('max-md:sr-only');
    // sr-only is position:absolute: the scrolling strip must be its containing block, or the
    // headings escape its overflow clipping and widen the page at 390 px (RTL showed a blank page).
    const strip = heading.parentElement?.parentElement;
    expect(strip?.className).toContain('max-md:overflow-x-auto');
    expect(strip?.className.split(' ')).toContain('relative');
  });

  it('shows team leads only Macros and Teams, under their own groups', () => {
    renderIn(<AdminNav role="TEAM_LEAD" />);
    const navigation = screen.getByRole('navigation');
    expect(
      within(navigation)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Ticket setup', 'People & clients']);
    expect(
      within(navigation)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Back to console', 'Overview', 'Macros', 'Teams & members']);
  });

  it('lists the sections by group on the overview (Arabic too)', () => {
    renderIn(<AdminOverview role="SUPER_ADMIN" />, 'ar');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'إعداد التذاكر',
      'مهلة الخدمة والتصعيد',
      'الأشخاص والعملاء',
      'التواصل',
      'النظام',
    ]);
    expect(screen.getAllByRole('link')).toHaveLength(14);
    cleanup();

    renderIn(<AdminOverview role="TEAM_LEAD" />);
    expect(screen.getByText('Manage your team’s members and macros.')).toBeTruthy();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/admin/macros',
      '/admin/teams',
    ]);
  });
});

describe('section registry', () => {
  it('has a component for every section, rendering its title', async () => {
    stubBrowserApis();
    // The sections load their data: keep every request pending (the header renders anyway).
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    const messages = await loadMessages('en');
    try {
      for (const section of ADMIN_SECTIONS) {
        const Section = ADMIN_SECTION_COMPONENTS[section];
        expect(Section, section).toBeTypeOf('function');
        render(
          <QueryClientProvider client={new QueryClient()}>
            <NextIntlClientProvider locale="en" timeZone="Asia/Qatar" messages={messages}>
              <Section role="SUPER_ADMIN" userId="u" />
            </NextIntlClientProvider>
          </QueryClientProvider>,
        );
        expect(
          screen.getByRole('heading', { level: 1, name: enAdmin.sections[section].title }),
          section,
        ).toBeTruthy();
        cleanup();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
