// TanStack Query keys of the console Reports page (Phase 5 F10–F12). Every key starts with
// 'reports' — never under ['tickets', 'list']. The realtime layer refetches `all` on
// `queue:updated` and after a reconnect, and on `config:updated` scopes `ticket-form` and
// `calendar` (lib/realtime/provider.tsx, config-scopes.ts); the page also polls every 60 s.

import type { ReportPeriod } from '@loons/shared';

export const reportKeys = {
  all: ['reports'] as const,
  summaries: () => ['reports', 'summary'] as const,
  summary: (period: ReportPeriod) => ['reports', 'summary', period] as const,
};
