import { CONFIG_SCOPES, type ConfigScope } from '@loons/shared';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { adminKeys } from '@/lib/admin/keys';
import { helpKeys } from '@/lib/help/keys';
import { requiredFormConfigVersion } from '@/lib/tickets/config-version';
import { ticketKeys } from '@/lib/tickets/keys';
import { FORM_CONFIG } from '@/lib/tickets/test-fixtures';
import {
  CONFIG_SCOPE_TARGETS,
  RECONNECT_CONFIG_KEYS,
  applyConfigUpdated,
  queryKeysForConfigScope,
} from './config-scopes';

const has = (keys: QueryKey[], key: QueryKey) =>
  keys.some((k) => JSON.stringify(k) === JSON.stringify(key));

describe('config:updated scope → query keys (E18)', () => {
  it('maps every shared scope', () => {
    expect(Object.keys(CONFIG_SCOPE_TARGETS).sort()).toEqual([...CONFIG_SCOPES].sort());
    for (const scope of CONFIG_SCOPES) {
      const keys = queryKeysForConfigScope(scope);
      // Every admin write adds an audit row: an open audit log refreshes whatever the scope.
      expect(has(keys, adminKeys.section('audit-log')), scope).toBe(true);
      expect(new Set(keys.map((k) => JSON.stringify(k))).size, scope).toBe(keys.length);
    }
  });

  const expectations: Record<ConfigScope, { include: QueryKey[]; exclude?: QueryKey[] }> = {
    'ticket-form': {
      include: [
        ticketKeys.formConfig(),
        ticketKeys.details(),
        adminKeys.section('categories'),
        adminKeys.section('custom-fields'),
        adminKeys.section('sla'),
      ],
      exclude: [ticketKeys.macros(), ticketKeys.formContexts()],
    },
    'form-context': {
      include: [
        ticketKeys.formContexts(),
        ticketKeys.requesterSearches(),
        ticketKeys.details(),
        adminKeys.section('clients'),
      ],
      exclude: [ticketKeys.formConfig()],
    },
    macros: {
      include: [ticketKeys.macros(), adminKeys.section('macros')],
      exclude: [ticketKeys.formConfig(), ticketKeys.details()],
    },
    teams: {
      include: [
        ticketKeys.teams(),
        ticketKeys.formConfig(),
        ticketKeys.details(),
        adminKeys.section('teams'),
      ],
    },
    escalation: {
      include: [ticketKeys.details(), adminKeys.section('escalation')],
      exclude: [ticketKeys.formConfig()],
    },
    calendar: {
      include: [ticketKeys.formConfig(), ticketKeys.details(), adminKeys.section('business-hours')],
    },
    staff: {
      include: [
        adminKeys.section('staff'),
        ticketKeys.teams(),
        ticketKeys.details(),
        // Escalation warnings and account-manager names depend on a person's state.
        adminKeys.section('escalation'),
        adminKeys.section('clients'),
      ],
      exclude: [ticketKeys.formConfig()],
    },
    'email-templates': {
      include: [adminKeys.section('email-templates')],
      exclude: [ticketKeys.formConfig(), ticketKeys.details()],
    },
    'help-center': {
      // The portal Help center too, in every language (Phase 5 F13).
      include: [adminKeys.section('help-center'), helpKeys.all],
      exclude: [ticketKeys.formConfig(), ticketKeys.details()],
    },
    settings: { include: [adminKeys.section('settings'), ticketKeys.formConfig()] },
    audit: { include: [adminKeys.section('audit-log')], exclude: [ticketKeys.formConfig()] },
  };

  for (const [scope, { include, exclude = [] }] of Object.entries(expectations)) {
    it(`${scope}`, () => {
      const keys = queryKeysForConfigScope(scope as ConfigScope);
      for (const key of include) expect(has(keys, key), JSON.stringify(key)).toBe(true);
      for (const key of exclude) expect(has(keys, key), JSON.stringify(key)).toBe(false);
    });
  }

  function seeded() {
    const queryClient = new QueryClient();
    queryClient.setQueryData(ticketKeys.formConfig(), FORM_CONFIG);
    queryClient.setQueryData(ticketKeys.formContext(null), { any: 1 });
    queryClient.setQueryData(ticketKeys.formContext('00000000-0000-4000-8000-000000000001'), {});
    queryClient.setQueryData(ticketKeys.requesters('aisha'), []);
    queryClient.setQueryData(ticketKeys.macros(), []);
    queryClient.setQueryData(ticketKeys.detail('LG-1'), {});
    queryClient.setQueryData(adminKeys.list('clients', { includeArchived: true }), []);
    queryClient.setQueryData(adminKeys.list('macros'), []);
    queryClient.setQueryData(adminKeys.staffDirectory(), []);
    const stale = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated === true;
    return { queryClient, stale };
  }

  it('invalidates the matching caches and records the announced version', () => {
    const { queryClient, stale } = seeded();
    applyConfigUpdated(queryClient, { scope: 'form-context', version: 7 });
    expect(stale(ticketKeys.formContext(null))).toBe(true);
    expect(stale(ticketKeys.formContext('00000000-0000-4000-8000-000000000001'))).toBe(true);
    expect(stale(ticketKeys.requesters('aisha'))).toBe(true);
    expect(stale(ticketKeys.detail('LG-1'))).toBe(true);
    expect(stale(adminKeys.list('clients', { includeArchived: true }))).toBe(true);
    expect(stale(ticketKeys.formConfig())).toBe(false);
    expect(stale(ticketKeys.macros())).toBe(false);
    expect(stale(adminKeys.list('macros'))).toBe(false);
    expect(requiredFormConfigVersion(queryClient)).toBe(7);

    // An older announcement never lowers the wanted version.
    applyConfigUpdated(queryClient, { scope: 'macros', version: 3 });
    expect(stale(ticketKeys.macros())).toBe(true);
    expect(requiredFormConfigVersion(queryClient)).toBe(7);
  });

  it('refreshes the staff pickers on a staff change', () => {
    const { queryClient, stale } = seeded();
    queryClient.setQueryData(adminKeys.list('escalation'), []);
    applyConfigUpdated(queryClient, { scope: 'staff', version: 2 });
    expect(stale(adminKeys.staffDirectory())).toBe(true);
    expect(stale(adminKeys.list('escalation'))).toBe(true);
    expect(stale(adminKeys.list('clients', { includeArchived: true }))).toBe(true);
    expect(stale(ticketKeys.formConfig())).toBe(false);
  });

  it('refreshes every scope for a payload it does not understand (a newer API)', () => {
    const { queryClient, stale } = seeded();
    applyConfigUpdated(queryClient, { scope: 'something-new', version: 9 });
    for (const key of [
      ticketKeys.formConfig(),
      ticketKeys.formContext(null),
      ticketKeys.macros(),
      adminKeys.list('macros'),
      adminKeys.staffDirectory(),
    ]) {
      expect(stale(key), JSON.stringify(key)).toBe(true);
    }
    expect(requiredFormConfigVersion(queryClient)).toBe(9);
    applyConfigUpdated(queryClient, null);
    expect(requiredFormConfigVersion(queryClient)).toBe(9);
  });

  it('refetches config after a reconnect (events sent meanwhile were missed)', () => {
    expect(has([...RECONNECT_CONFIG_KEYS], ticketKeys.formConfig())).toBe(true);
    expect(has([...RECONNECT_CONFIG_KEYS], ticketKeys.formContexts())).toBe(true);
    expect(has([...RECONNECT_CONFIG_KEYS], adminKeys.all)).toBe(true);
    // The portal Help center (clients too): an article published while offline shows (F13).
    expect(has([...RECONNECT_CONFIG_KEYS], helpKeys.all)).toBe(true);
  });

  it('help-center refreshes the portal articles in every language, and nothing else of the portal', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(helpKeys.articles('en'), { locale: 'en', items: [] });
    queryClient.setQueryData(helpKeys.articles('ar'), { locale: 'ar', items: [] });
    queryClient.setQueryData(ticketKeys.detail('LG-1'), {});
    const stale = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated === true;
    applyConfigUpdated(queryClient, { scope: 'help-center', version: 3 });
    expect(stale(helpKeys.articles('en'))).toBe(true);
    expect(stale(helpKeys.articles('ar'))).toBe(true);
    expect(stale(ticketKeys.detail('LG-1'))).toBe(false);
    // Other scopes leave the articles alone.
    const other = new QueryClient();
    other.setQueryData(helpKeys.articles('en'), { locale: 'en', items: [] });
    applyConfigUpdated(other, { scope: 'macros', version: 4 });
    expect(other.getQueryState(helpKeys.articles('en'))?.isInvalidated).toBe(false);
  });
});
