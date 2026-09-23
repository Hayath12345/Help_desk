'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Logo } from '@/components/common/logo';
import { LanguageToggle } from './language-toggle';
import { TopNavLink } from './nav-link';
import { NewTicketButton } from './new-ticket-button';
import type { ShellUser } from './types';
import { UserMenu } from './user-menu';

const PORTAL_NAV = [
  { key: 'tickets', href: '/tickets' },
  { key: 'help', href: '/help' },
] as const satisfies readonly { key: string; href: Route }[];

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Client portal top bar (design 554–574): 60px white sticky bar. */
export function PortalTopBar({ user }: { user: ShellUser }) {
  const t = useTranslations('portal.nav');
  const tc = useTranslations('common');
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 flex h-15 shrink-0 items-center gap-2 border-b border-line bg-surface px-4 sm:gap-6 sm:px-6">
      <Link href="/tickets" className="flex shrink-0 items-center rounded-sm text-ink no-underline hover:text-ink">
        <Logo suffix={tc('support')} compact />
      </Link>
      <nav aria-label={t('label')} className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto no-scrollbar sm:gap-1">
        {PORTAL_NAV.map((item) => (
          <TopNavLink key={item.key} href={item.href} active={isActive(pathname, item.href)} className="max-sm:px-2">
            {t(item.key)}
          </TopNavLink>
        ))}
      </nav>
      <NewTicketButton compact />
      <LanguageToggle className="max-sm:px-2" />
      <UserMenu name={user.name} email={user.email} initials={user.initials} />
    </header>
  );
}
