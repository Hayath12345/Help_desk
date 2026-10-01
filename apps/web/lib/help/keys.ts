// TanStack Query keys of the portal Help center (docs/PHASE5_CONTRACT.md F13, F16). Every key starts
// with 'help' — never under ['tickets', …] — so `config:updated` with scope `help-center` and a
// reconnect refresh them with one prefix (lib/realtime/config-scopes.ts).

import type { Locale } from '@loons/shared';

export const helpKeys = {
  all: ['help'] as const,
  /** Published articles as a reader of `locale` gets them (GET /help/articles?locale=). */
  articles: (locale: Locale) => ['help', locale] as const,
};
