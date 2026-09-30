// `config:updated {scope, version}` → the TanStack Query caches it makes stale (docs/PHASE4_CONTRACT.md
// E18; scope meanings in `@loons/shared` realtime.ts). Used by the realtime provider for pushes
// from other admins, and by the admin mutations for the admin's own tab (so it does not wait for
// its own broadcast).

import { CONFIG_SCOPES, configUpdatedPayloadSchema, type ConfigScope } from '@loons/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { adminKeys } from '@/lib/admin/keys';
import { requireFormConfigVersion } from '@/lib/tickets/config-version';
import { ticketKeys } from '@/lib/tickets/keys';

export interface ConfigScopeTargets {
  /** The New-ticket form config embeds it: refetch it (chasing the announced version). */
  formConfig: boolean;
  /** Other query-key prefixes to refetch (active queries) or mark stale (inactive ones). */
  keys: readonly QueryKey[];
}

export const CONFIG_SCOPE_TARGETS: Record<ConfigScope, ConfigScopeTargets> = {
  // Categories, sub-types, custom fields, SLA policies, security category.
  'ticket-form': {
    formConfig: true,
    keys: [
      ticketKeys.details(),
      adminKeys.section('categories'),
      adminKeys.section('custom-fields'),
      adminKeys.section('sla'),
      adminKeys.section('settings'),
    ],
  },
  // Organisations and sites: the New-ticket form context (org chip, sites), the staff requester
  // search (archived organisations drop out) and ticket details (site / org labels).
  'form-context': {
    formConfig: false,
    keys: [
      ticketKeys.formContexts(),
      ticketKeys.requesterSearches(),
      ticketKeys.details(),
      adminKeys.section('clients'),
    ],
  },
  macros: { formConfig: false, keys: [ticketKeys.macros(), adminKeys.section('macros')] },
  // Teams, members, on-call: the assignee picker / Teams column, team names in the form config
  // and on tickets, and the admin screens that show teams (routing, escalation, staff).
  teams: {
    formConfig: true,
    keys: [
      ticketKeys.teams(),
      ticketKeys.details(),
      adminKeys.section('teams'),
      adminKeys.section('categories'),
      adminKeys.section('escalation'),
      adminKeys.section('staff'),
    ],
  },
  // Escalation rules: the P1 chain on ticket details (`p1Chain`).
  escalation: { formConfig: false, keys: [ticketKeys.details(), adminKeys.section('escalation')] },
  // Business hours, holidays, timezone: business-day length in the form config, SLA on details.
  calendar: {
    formConfig: true,
    keys: [
      ticketKeys.details(),
      adminKeys.section('business-hours'),
      adminKeys.section('sla'),
      adminKeys.section('settings'),
    ],
  },
  // Staff accounts: the staff pickers and teams, plus the screens that show a person's name or
  // state — escalation warnings (disabled target, no phone), account managers on Clients, and
  // assignee / P1-chain names on ticket details.
  staff: {
    formConfig: false,
    keys: [
      adminKeys.section('staff'),
      ticketKeys.teams(),
      ticketKeys.details(),
      adminKeys.section('teams'),
      adminKeys.section('escalation'),
      adminKeys.section('clients'),
    ],
  },
  'email-templates': { formConfig: false, keys: [adminKeys.section('email-templates')] },
  'help-center': { formConfig: false, keys: [adminKeys.section('help-center')] },
  // General settings: the SOC phone and security category are part of the form config.
  settings: { formConfig: true, keys: [adminKeys.section('settings')] },
  audit: { formConfig: false, keys: [adminKeys.section('audit-log')] },
};

/**
 * Every admin write appends an audit row (E17), so an open audit log refreshes whatever the
 * scope.
 */
const ALWAYS: readonly QueryKey[] = [adminKeys.section('audit-log')];

/** The query-key prefixes a scope makes stale (the form config included when it embeds it). */
export function queryKeysForConfigScope(scope: ConfigScope): QueryKey[] {
  const targets = CONFIG_SCOPE_TARGETS[scope];
  const keys: QueryKey[] = targets.formConfig ? [ticketKeys.formConfig()] : [];
  for (const key of [...targets.keys, ...ALWAYS]) {
    if (!keys.some((k) => JSON.stringify(k) === JSON.stringify(key))) keys.push(key);
  }
  return keys;
}

/**
 * Applies a `config:updated` payload: records the announced version (the form-config query
 * refetches until it has it) and invalidates every cache the scope touches. A payload this client
 * doesn't understand (an unknown scope from a newer API) refreshes every scope — stale config is
 * worse than a few extra requests.
 */
export function applyConfigUpdated(queryClient: QueryClient, payload: unknown): void {
  const parsed = configUpdatedPayloadSchema.safeParse(payload);
  const scopes: readonly ConfigScope[] = parsed.success ? [parsed.data.scope] : CONFIG_SCOPES;
  const version = parsed.success
    ? parsed.data.version
    : (payload as { version?: unknown } | null | undefined)?.version;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > 0) {
    requireFormConfigVersion(queryClient, version);
  }
  const keys = new Map<string, QueryKey>();
  for (const scope of scopes) {
    for (const key of queryKeysForConfigScope(scope)) keys.set(JSON.stringify(key), key);
  }
  for (const key of keys.values()) void queryClient.invalidateQueries({ queryKey: key });
}

/**
 * After a reconnect every `config:updated` sent meanwhile was missed: refetch what config feeds
 * (the form config and form contexts, macros, teams, and whatever admin screen is open).
 */
export const RECONNECT_CONFIG_KEYS: readonly QueryKey[] = [
  ticketKeys.formConfig(),
  ticketKeys.formContexts(),
  ticketKeys.macros(),
  ticketKeys.teams(),
  adminKeys.all,
];
