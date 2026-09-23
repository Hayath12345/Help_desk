'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface TopNavLinkProps {
  href: Route;
  active: boolean;
  /** Active background: portal uses surface-sunken, the console the lighter divider grey (design). */
  tone?: 'portal' | 'console';
  children: React.ReactNode;
  className?: string;
}

/** Top-bar navigation pill: 7px 12px, 8px radius, medium weight; muted until active. */
export function TopNavLink({ href, active, tone = 'portal', children, className }: TopNavLinkProps) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center rounded-md px-3 py-[7px] font-medium whitespace-nowrap no-underline transition-colors duration-150 ease-out',
        active
          ? cn('text-ink hover:text-ink', tone === 'portal' ? 'bg-surface-sunken' : 'bg-divider')
          : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** "Skip to content" link, visible only when focused. Target: <main id="main">. */
export function SkipLink({ label }: { label: string }) {
  return (
    <a
      href="#main"
      className="sr-only rounded-md bg-surface px-3 py-2 font-medium text-ink shadow-menu focus:not-sr-only focus:fixed focus:top-2 focus:inset-s-2 focus:z-50"
    >
      {label}
    </a>
  );
}
