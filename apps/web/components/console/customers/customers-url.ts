'use client';

// URL state of the console Customers page (Phase 5 F8): /console/customers?q=
// - q   the search (requester name, email or company; ≤ 100 characters like the API)
// The search box writes it with history.replaceState after a typing pause (no history entry per
// keystroke, no reload); Next.js syncs useSearchParams() with the History API, so Back / Forward
// and shared links work.

import { CUSTOMER_LIMITS } from '@loons/shared';
import { useSearchParams } from 'next/navigation';

export const CUSTOMERS_PATH = '/console/customers';
export const CUSTOMER_SEARCH_MAX = CUSTOMER_LIMITS.searchMax;

interface ParamsLike {
  get(name: string): string | null;
}

/** The search of a query string (trimmed, capped); '' when none. */
export function parseCustomerSearch(params: ParamsLike | null | undefined): string {
  return (params?.get('q') ?? '').trim().slice(0, CUSTOMER_SEARCH_MAX);
}

/** `/console/customers?q=…` ('' search → the bare path). */
export function customersHref(search: string): string {
  const q = search.trim().slice(0, CUSTOMER_SEARCH_MAX);
  return q ? `${CUSTOMERS_PATH}?${new URLSearchParams({ q }).toString()}` : CUSTOMERS_PATH;
}

/** Replaces the search in the current URL (the Customers page); no-op when unchanged. */
export function replaceCustomerSearch(search: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const q = search.trim().slice(0, CUSTOMER_SEARCH_MAX);
  if ((url.searchParams.get('q') ?? '') === q) return;
  if (q) url.searchParams.set('q', q);
  else url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', url);
}

/** The search in the current URL (re-renders on replaceState / Back). */
export function useCustomerSearchParam(): string {
  return parseCustomerSearch(useSearchParams());
}
