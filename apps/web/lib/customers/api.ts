// Typed fetchers of the Phase 5 Customers API (staff only; api-contracts: GET /customers,
// GET /customers/orgs/:id). Responses are parsed with the shared contract schemas outside
// production, like lib/tickets/api.ts.

import {
  customerListSchema,
  customerOrgResponseSchema,
  type CustomerList,
  type CustomerOrg,
} from '@loons/shared';
import { apiClient } from '@/lib/api/browser';
import { parseResponse, withQuery } from '@/lib/tickets/api';

/**
 * One page of GET /customers: active client requesters sorted by name, with open / total counts
 * over the tickets the caller can see, and `totals` for the whole search.
 */
export async function fetchCustomers(
  search: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<CustomerList> {
  const data = await apiClient.get<unknown>(
    withQuery('/customers', { search: search.trim(), cursor }),
    { signal },
  );
  return parseResponse(customerListSchema, data);
}

/** GET /customers/orgs/:id — an organisation's name and contract (company view title). */
export async function fetchCustomerOrg(id: string, signal?: AbortSignal): Promise<CustomerOrg> {
  const data = await apiClient.get<unknown>(`/customers/orgs/${encodeURIComponent(id)}`, {
    signal,
  });
  return parseResponse(customerOrgResponseSchema, data).org;
}
