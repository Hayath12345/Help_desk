'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { placeName } from '@/lib/tickets/labels';
import { useRequesterSearch } from '@/lib/tickets/queries';
import { Combobox, type ComboboxOption } from '../combobox';

/** `value`, updated `delayMs` after it stops changing. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface RequesterFieldProps {
  id: string;
  value: string;
  onValueChange: (requesterId: string) => void;
  /** Label of the chosen requester when it isn't in the current results (prefilled / loaded). */
  selectedLabel?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

/** Staff "Requester" picker: server-side search over active, verified client contacts. */
export function RequesterField({
  id,
  value,
  onValueChange,
  selectedLabel,
  ref,
  ...aria
}: RequesterFieldProps) {
  const t = useTranslations('tickets');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 250);
  const query = useRequesterSearch(debounced, { enabled: open || !!value });

  const options: ComboboxOption[] = (query.data ?? []).map((r) => ({
    value: r.id,
    label: `${r.name} — ${placeName(r.org, locale)}`,
    description: r.email,
  }));

  return (
    <Combobox
      ref={ref}
      id={id}
      value={value}
      onValueChange={onValueChange}
      options={options}
      selectedLabel={selectedLabel}
      placeholder={t('newTicket.requesterPlaceholder')}
      searchPlaceholder={t('newTicket.requesterSearch')}
      emptyText={t('newTicket.requesterNone')}
      loading={query.isFetching}
      loadingText={t('combobox.loading')}
      onSearchChange={setSearch}
      onOpenChange={setOpen}
      aria-invalid={aria['aria-invalid']}
      aria-describedby={aria['aria-describedby']}
    />
  );
}
