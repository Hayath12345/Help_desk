'use client';

import { Menu } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Logo } from '@/components/common/logo';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ConsoleSearchBox } from './console-search';
import { LanguageToggle } from './language-toggle';
import { TopNavLink } from './nav-link';
import { NotificationBell } from './notification-bell';
import { PresenceToggle } from './presence-toggle';
import type { ShellUser } from './types';
import { UserMenu } from './user-menu';

type NavKey = 'inbox' | 'queue' | 'customers' | 'reports' | 'admin';

const CONSOLE_NAV = [
  { key: 'inbox', href: '/console/inbox' },
  { key: 'queue', href: '/console/queue' },
  { key: 'customers', href: '/console/customers' },
  { key: 'reports', href: '/console/reports' },
] as const satisfies readonly { key: NavKey; href: Route }[];

const ADMIN_NAV = { key: 'admin', href: '/admin' } as const satisfies { key: NavKey; href: Route };

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface ConsoleTopBarProps {
  user: ShellUser;
  /** `admin` hides the ticket search (it searches tickets, which the admin pages don't list). */
  area?: 'console' | 'admin';
}

/**
 * Agent console top bar (design 676–705): logo, Inbox / Team queue / Customers / Reports
 * (+ Admin for super admins and team leads), ticket search, Online/Away, the notification bell
 * (Phase 3), language, account menu.
 * Below `lg` the section links collapse into a menu button — below `xl` when Admin is a fifth
 * link, which would push the account menu off the bar at 1024 px.
 */
export function ConsoleTopBar({ user, area = 'console' }: ConsoleTopBarProps) {
  const t = useTranslations('console.nav');
  const pathname = usePathname();
  const canAdmin = user.role === 'SUPER_ADMIN' || user.role === 'TEAM_LEAD';
  const items: readonly { key: NavKey; href: Route }[] = canAdmin
    ? [...CONSOLE_NAV, ADMIN_NAV]
    : CONSOLE_NAV;
  const home: Route = area === 'admin' ? '/admin' : '/console/inbox';
  const wideNav = items.length > CONSOLE_NAV.length;

  return (
    <header className="sticky top-0 z-10 flex h-15 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 sm:px-5 lg:gap-5">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('menu')}
            className={cn('-ms-1.5 text-ink-secondary', wideNav ? 'xl:hidden' : 'lg:hidden')}
          >
            <Menu aria-hidden="true" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={10} className="w-56">
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <DropdownMenuItem key={item.key} asChild>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('no-underline', active && 'bg-surface-sunken font-medium')}
                >
                  {t(item.key)}
                </Link>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Link
        href={home}
        className="flex shrink-0 items-center rounded-sm text-ink no-underline hover:text-ink"
      >
        <Logo compact />
      </Link>

      <nav
        aria-label={t('label')}
        className={cn('flex gap-0.5', wideNav ? 'max-xl:hidden' : 'max-lg:hidden')}
      >
        {items.map((item) => (
          <TopNavLink
            key={item.key}
            href={item.href}
            active={isActive(pathname, item.href)}
            tone="console"
          >
            {t(item.key)}
          </TopNavLink>
        ))}
      </nav>

      {area === 'console' ? (
        <ConsoleSearchBox className="max-w-[440px] min-w-[140px] flex-1 max-sm:hidden" />
      ) : null}

      <div className="flex-1" />

      <PresenceToggle />
      <NotificationBell />
      <LanguageToggle />
      <UserMenu name={user.name} email={user.email} initials={user.initials} showNewTicket />
    </header>
  );
}
