'use client';

// The configured business-day length (decision E12) for "N business days" labels, read from the
// ticket form config that is already cached (New Ticket form, console prefetch). It never fetches:
// before the config is known — or outside a QueryClientProvider — the 9-hour default applies.
// Admin changes to the business hours reach it through `config:updated` (scope `calendar`), which
// refetches the form config.

import type { TicketFormConfig } from '@loons/shared';
import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useSyncExternalStore } from 'react';
import { ticketKeys } from './keys';
import { BUSINESS_DAY_MINUTES } from './sla-format';

export function useConfiguredBusinessDayMinutes(): number {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => (client ? client.getQueryCache().subscribe(onChange) : () => {}),
    [client],
  );
  const read = useCallback(() => {
    const minutes = client?.getQueryData<TicketFormConfig>(
      ticketKeys.formConfig(),
    )?.businessDayMinutes;
    return typeof minutes === 'number' && minutes > 0 ? minutes : BUSINESS_DAY_MINUTES;
  }, [client]);
  return useSyncExternalStore(subscribe, read, read);
}
