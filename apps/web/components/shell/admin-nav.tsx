'use client';

import type { Role } from '@loons/shared';
import { ArrowLeft, LayoutGrid, type LucideIcon } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Kicker } from '@/components/common/kicker';
import { cn } from '@/lib/utils';
import { ADMIN_SECTION_ICONS, allowedAdminGroups } from './admin-sections';

function NavItem({
  href,
  icon: Icon,
  active,
  children,
}: {
  href: Route;
  icon: LucideIcon;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-[9px] text-[15px] whitespace-nowrap no-underline transition-[background-color,color,box-shadow] duration-150 ease-out',
        active
          ? 'bg-surface text-ink shadow-segment hover:text-ink'
          : 'text-ink-secondary hover:bg-surface hover:text-ink',
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-4 shrink-0', active ? 'text-brand' : 'text-ink-muted')}
      />
      {children}
    </Link>
  );
}

/**
 * Admin section navigation (inline-start column, same language as the console's Views column):
 * Overview, then the sections under small group headings (E8). Team leads only see Teams and
 * Macros (and their groups); the API enforces the same rule. Below `md` it becomes one
 * horizontally scrolling strip (the group headings stay for screen readers).
 */
export function AdminNav({ role, className }: { role: Role; className?: string }) {
  const t = useTranslations('admin');
  const pathname = usePathname();
  const groups = allowedAdminGroups(role);

  return (
    <nav aria-label={t('navLabel')} className={cn('flex flex-col gap-4 md:gap-5', className)}>
      <Link
        href="/console/inbox"
        className="inline-flex w-fit items-center gap-1.5 px-2.5 text-[13px] text-ink-muted no-underline transition-colors hover:text-ink max-md:hidden"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
        {t('backToConsole')}
      </Link>
      {/* `relative`: the group headings are visually hidden (absolutely positioned) on phones; the
          strip must be their containing block, or they escape its scrolling and widen the page. */}
      <div className="relative flex min-w-0 gap-0.5 max-md:-mx-1 max-md:overflow-x-auto max-md:px-1 max-md:pb-1 max-md:no-scrollbar md:flex-col md:gap-[18px]">
        <ul className="flex shrink-0 md:flex-col">
          <li>
            <NavItem href="/admin" icon={LayoutGrid} active={pathname === '/admin'}>
              {t('overview')}
            </NavItem>
          </li>
        </ul>
        {groups.map((group) => {
          const headingId = `admin-nav-${group.id}`;
          return (
            <div key={group.id} className="flex shrink-0 flex-col gap-0.5">
              <Kicker as="h2" id={headingId} className="px-2.5 pb-1.5 max-md:sr-only">
                {t(`groups.${group.id}`)}
              </Kicker>
              <ul aria-labelledby={headingId} className="flex gap-0.5 md:flex-col">
                {group.sections.map((section) => {
                  const href = `/admin/${section}` as Route;
                  return (
                    <li key={section}>
                      <NavItem
                        href={href}
                        icon={ADMIN_SECTION_ICONS[section]}
                        active={pathname === href || pathname.startsWith(`${href}/`)}
                      >
                        {t(`sections.${section}.title`)}
                      </NavItem>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
