'use client';

// TanStack Query hooks of the Customers page and the Inbox company view. Keys: ./keys.ts.
// Kept live by the realtime layer (queue:updated, reconnect, config scope `form-context`) and a
// 60 s refresh while the tab is visible.

import type { CustomerList, CustomerRow } from '@loons/shared';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import { isApiRequestError } from '@/lib/api/errors';
import { fetchCustomerOrg, fetchCustomers } from './api';
import { customerKeys, normalizeCustomerSearch } from './keys';

const FIVE_MINUTES = 5 * 60_000;

/**
 * `queue:updated` goes to team rooms: a ticket assigned to the viewer on another team changes
 * their counts without reaching them, so the list also refreshes every minute (paused while the
 * tab is hidden), like the Team queue and Reports.
 */
export const CUSTOMERS_REFRESH_MS = 60_000;

/** Don't retry answers that won't change (403 / 404 / validation). */
function retryTransient(failureCount: number, error: unknown): boolean {
  if (isApiRequestError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export type CustomerPages = InfiniteData<CustomerList, string | null>;

/** `useCustomers().data`: the pages, every loaded row in order, and the search's totals. */
export type CustomerPagesWithItems = CustomerPages & {
  items: CustomerRow[];
  totals: CustomerList['totals'];
};

export function selectCustomerPages(data: CustomerPages): CustomerPagesWithItems {
  // A row can move to another page between two page loads (a rename): keep its first copy.
  const seen = new Set<string>();
  const items: CustomerRow[] = [];
  for (const page of data.pages) {
    for (const row of page.items) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      items.push(row);
    }
  }
  const totals = data.pages[0]?.totals ?? { requesters: 0, companies: 0 };
  return { ...data, items, totals };
}

/**
 * Client requesters matching `search` (name, email or company), keyset-paged by name ("Load
 * more" = `fetchNextPage()`). While another search loads, the previous rows stay
 * (`isPlaceholderData`).
 */
export function useCustomers(search: string) {
  const term = normalizeCustomerSearch(search);
  return useInfiniteQuery({
    queryKey: customerKeys.list(term),
    queryFn: ({ pageParam, signal }) => fetchCustomers(term, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    select: selectCustomerPages,
    placeholderData: keepPreviousData,
    retry: retryTransient,
    refetchInterval: CUSTOMERS_REFRESH_MS,
  });
}

/** A client organisation by id (the company view's title; works from a shared URL). */
export function useCustomerOrg(id: string | null | undefined) {
  return useQuery({
    queryKey: customerKeys.org(id ?? ''),
    queryFn: ({ signal }) => fetchCustomerOrg(id ?? '', signal),
    staleTime: FIVE_MINUTES,
    retry: retryTransient,
    enabled: !!id,
  });
}
