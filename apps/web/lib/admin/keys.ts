// TanStack Query keys of the admin panel. Every key starts with ['admin', <section>] so one prefix
// covers a whole section (lists, details, pickers it owns) and ['admin'] covers the panel. The
// realtime layer invalidates these prefixes on `config:updated` (lib/realtime/config-scopes.ts).

import type { AdminSlug } from './sections';

/** Query parameters of one admin list (filters, `includeArchived`, a cursor-less search…). */
export type AdminListParams = Record<string, string | number | boolean | null | undefined>;

/** Drops empty values and sorts keys so equivalent parameter objects produce the same key. */
export function normalizeAdminParams(params: AdminListParams = {}): AdminListParams {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

export const adminKeys = {
  all: ['admin'] as const,
  /** Everything one section caches. */
  section: (section: AdminSlug) => ['admin', section] as const,
  lists: (section: AdminSlug) => ['admin', section, 'list'] as const,
  list: (section: AdminSlug, params?: AdminListParams) =>
    ['admin', section, 'list', normalizeAdminParams(params)] as const,
  details: (section: AdminSlug) => ['admin', section, 'detail'] as const,
  detail: (section: AdminSlug, id: string) => ['admin', section, 'detail', id] as const,
  /**
   * Staff picker (account manager, on-call user, escalation USER targets, add member). Lives under
   * the staff section, so a `staff` change refreshes it.
   */
  staffDirectory: (params?: AdminListParams) =>
    ['admin', 'staff', 'directory', normalizeAdminParams(params)] as const,
};
