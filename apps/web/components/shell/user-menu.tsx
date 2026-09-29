'use client';

import { LogOut, SquarePen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { signOutAction } from '@/app/actions/auth';
import { useNewTicket } from '@/components/tickets/new-ticket/new-ticket-context';
import { clearApiToken } from '@/lib/api/browser';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface UserMenuProps {
  name: string;
  email: string;
  initials: string;
  /** Staff menus also offer "New ticket" (opens the New ticket modal via `useNewTicket()`). */
  showNewTicket?: boolean;
}

/** 34px initials button → 220px menu with the user's name/email and Sign out (design 566–572). */
export function UserMenu({ name, email, initials, showNewTicket = false }: UserMenuProps) {
  const t = useTranslations('common');
  const newTicket = useNewTicket();
  // The sign-out form lives outside the menu so it stays mounted while the menu closes.
  const signOutForm = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={signOutForm} action={signOutAction} hidden />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('accountMenu')}
            className="grid size-[34px] shrink-0 cursor-pointer place-items-center rounded-full bg-brand-soft text-xs font-semibold text-brand-ink transition-colors duration-150 hover:bg-selection data-[state=open]:bg-selection"
          >
            <span aria-hidden="true">{initials}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-[220px]">
          <DropdownMenuLabel className="mb-1 flex flex-col gap-0.5 border-b border-divider pt-2 pb-2.5 font-normal">
            <span className="truncate text-sm font-semibold text-ink">{name}</span>
            {/* LTR so a long address truncates at its end (not its local part) in Arabic.
                self-start keeps a short one on the menu's start edge (text-start would resolve
                against the span's own LTR direction); max-w-full caps a long one so it truncates. */}
            <span dir="ltr" className="max-w-full self-start truncate text-xs text-ink-muted">
              {email}
            </span>
          </DropdownMenuLabel>
          {showNewTicket ? (
            <DropdownMenuItem
              disabled={!newTicket.available}
              onPointerEnter={newTicket.prefetch}
              onSelect={() => {
                // Open after the menu has closed and handed focus back to its trigger, so the
                // dialog returns focus there when it closes.
                setTimeout(() => newTicket.open(), 0);
              }}
            >
              <SquarePen aria-hidden="true" />
              {t('newTicket')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() => {
              // Drop the cached API token first so the next user in this tab can never reuse it.
              clearApiToken();
              signOutForm.current?.requestSubmit();
            }}
          >
            <LogOut aria-hidden="true" className="rtl:-scale-x-100" />
            {t('signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
