'use client';

import { Command as CommandPrimitive } from 'cmdk';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useId, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second, muted line (e.g. an email or organisation). */
  description?: string;
  /** Extra search terms for client-side filtering (e.g. the Arabic name). */
  keywords?: string[];
}

export interface ComboboxProps {
  id: string;
  /** '' = nothing chosen. */
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ComboboxOption[];
  /** Trigger text while nothing is chosen. */
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Label of the chosen value when it isn't in `options` (e.g. a prefilled requester). */
  selectedLabel?: string;
  /** Server-side search: turns off local filtering and reports the query. */
  onSearchChange?: (search: string) => void;
  onOpenChange?: (open: boolean) => void;
  loading?: boolean;
  loadingText?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'aria-labelledby'?: string;
  className?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * Searchable single-select (design: requester and site pickers). A button with
 * role="combobox" opens a listbox with a search box; typing filters (locally, or on the server
 * via `onSearchChange`), arrows move, Enter picks, Escape closes and focus returns to the
 * trigger. The popover is modal so it scrolls correctly inside the New ticket dialog.
 */
export function Combobox({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  selectedLabel,
  onSearchChange,
  onOpenChange,
  loading = false,
  loadingText,
  disabled,
  className,
  ref,
  ...aria
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const listId = useId();
  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? (value ? selectedLabel : undefined);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && search) {
      setSearch('');
      onSearchChange?.('');
    }
    onOpenChange?.(next);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={changeOpen} modal>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={ref}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-invalid={aria['aria-invalid'] || undefined}
          aria-describedby={aria['aria-describedby']}
          aria-labelledby={aria['aria-labelledby']}
          disabled={disabled}
          className={cn(
            'flex h-10 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-line-input bg-surface ps-3 pe-2.5 text-start text-sm text-ink transition-[border-color,box-shadow] duration-150 ease-out outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint focus-visible:outline-hidden disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted aria-invalid:border-danger-strong aria-invalid:focus-visible:ring-danger-tint',
            className,
          )}
        >
          <span className={cn('min-w-0 truncate', !label && 'text-ink-muted')}>
            {label ?? placeholder}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          collisionPadding={12}
          className="z-50 w-(--radix-popover-trigger-width) min-w-60 origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-lg border border-line bg-surface text-ink shadow-menu outline-hidden duration-150 ease-out data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <CommandPrimitive shouldFilter={!onSearchChange} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-divider px-3">
              <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-ink-subtle" />
              <CommandPrimitive.Input
                value={search}
                onValueChange={(next) => {
                  setSearch(next);
                  onSearchChange?.(next);
                }}
                placeholder={searchPlaceholder}
                className="h-10 w-full min-w-0 bg-transparent text-sm text-ink outline-hidden placeholder:text-ink-muted"
              />
            </div>
            <CommandPrimitive.List
              id={listId}
              className="max-h-64 scroll-py-1 overflow-x-hidden overflow-y-auto p-1.5 outline-none"
            >
              {loading && options.length === 0 ? (
                <CommandPrimitive.Loading label={loadingText}>
                  <div className="flex flex-col gap-2 p-2" aria-hidden="true">
                    <Skeleton className="h-4 w-2/3 rounded-sm" />
                    <Skeleton className="h-4 w-1/2 rounded-sm" />
                    <Skeleton className="h-4 w-3/5 rounded-sm" />
                  </div>
                </CommandPrimitive.Loading>
              ) : (
                <CommandPrimitive.Empty className="px-2.5 py-5 text-center text-sm text-ink-muted">
                  {emptyText}
                </CommandPrimitive.Empty>
              )}
              {options.map((option) => (
                <CommandPrimitive.Item
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, option.description ?? '', ...(option.keywords ?? [])]}
                  onSelect={() => {
                    onValueChange(option.value);
                    // Close after the Enter key event has finished: closing returns focus to the
                    // trigger button, which would otherwise receive the same Enter and reopen.
                    setTimeout(() => changeOpen(false), 0);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-ink outline-none select-none data-[selected=true]:bg-surface-sunken data-[selected=true]:outline-hidden forced-colors:data-[selected=true]:-outline-offset-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate">{option.label}</span>
                    {option.description ? (
                      <span className="truncate text-xs text-ink-muted">{option.description}</span>
                    ) : null}
                  </span>
                  <CheckIcon
                    aria-hidden="true"
                    className={cn(
                      'size-4 shrink-0 text-brand',
                      option.value === value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                </CommandPrimitive.Item>
              ))}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
