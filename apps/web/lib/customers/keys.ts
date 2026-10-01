// TanStack Query keys of the console Customers page and the Inbox company view (Phase 5 F8, F9).
// Every key starts with 'customers' — never under ['tickets', 'list'], whose cache shape
// (TicketPages) the Inbox relies on. The realtime layer refetches `lists()` on `queue:updated`
// and after a reconnect, and everything on `config:updated` scope `form-context`
// (lib/realtime/provider.tsx, config-scopes.ts).

/** The search is the only filter; the cursor is the infinite query's page param. */
export function normalizeCustomerSearch(search: string | null | undefined): string {
  return (search ?? '').trim();
}

export const customerKeys = {
  all: ['customers'] as const,
  /** Every customer list (each search). */
  lists: () => ['customers', 'list'] as const,
  list: (search: string) => ['customers', 'list', normalizeCustomerSearch(search)] as const,
  /** Organisation look-ups (the Inbox company view's title). */
  orgs: () => ['customers', 'org'] as const,
  org: (id: string) => ['customers', 'org', id.toLowerCase()] as const,
};
