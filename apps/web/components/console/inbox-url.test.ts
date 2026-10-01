// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import {
  currentInboxState,
  inboxHref,
  isSelectedTicket,
  listFiltersFor,
  parseInboxParams,
  updateInboxUrl,
} from './inbox-url';

const TEAM = fixtureId(101);

afterEach(() => window.history.replaceState(null, '', '/'));

describe('parseInboxParams', () => {
  it('defaults to "My queue" with nothing selected', () => {
    expect(parseInboxParams(new URLSearchParams())).toEqual({
      view: 'mine',
      teamId: null,
      orgId: null,
      ticket: null,
      q: '',
    });
    expect(parseInboxParams(null).view).toBe('mine');
  });

  it('reads the view, team, ticket and search, normalising the ticket ref', () => {
    const state = parseInboxParams(
      new URLSearchParams({
        view: 'risk',
        team: TEAM.toUpperCase(),
        ticket: 'lg-4817',
        q: ' nvr ',
      }),
    );
    expect(state).toEqual({ view: 'risk', teamId: TEAM, orgId: null, ticket: 'LG-4817', q: 'nvr' });
  });

  it('ignores unknown views, malformed teams and oversized values', () => {
    const state = parseInboxParams(
      new URLSearchParams({
        view: 'urgent',
        team: 'soc',
        ticket: 'x'.repeat(65),
        q: 'a'.repeat(150),
      }),
    );
    expect(state.view).toBe('mine');
    expect(state.teamId).toBeNull();
    expect(state.ticket).toBeNull();
    expect(state.q).toHaveLength(100);
  });
});

describe('inboxHref', () => {
  it('omits defaults and keeps a stable order', () => {
    expect(inboxHref({})).toBe('/console/inbox');
    expect(inboxHref({ view: 'mine' })).toBe('/console/inbox');
    expect(inboxHref({ view: 'p1', ticket: 'LG-4817', q: 'fw' })).toBe(
      '/console/inbox?view=p1&ticket=LG-4817&q=fw',
    );
  });

  it('uses the team instead of the view while a team is selected', () => {
    expect(inboxHref({ view: 'risk', teamId: TEAM })).toBe(`/console/inbox?team=${TEAM}`);
  });

  it('round-trips through parseInboxParams', () => {
    const state = {
      view: 'solved' as const,
      teamId: null,
      orgId: null,
      ticket: 'LG-4771',
      q: 'camera',
    };
    const url = new URL(inboxHref(state), 'http://x');
    expect(parseInboxParams(url.searchParams)).toEqual(state);
  });
});

describe('listFiltersFor', () => {
  it('lists a view, or the active tickets of a team, with the search and sort', () => {
    const base = parseInboxParams(new URLSearchParams({ view: 'p1', q: 'fw' }));
    expect(listFiltersFor(base, 'sla')).toEqual({ view: 'p1', search: 'fw', sort: 'sla' });
    expect(listFiltersFor({ ...base, teamId: TEAM, q: '' }, 'recent')).toEqual({
      teamId: TEAM,
      view: 'open',
      search: undefined,
      sort: 'recent',
    });
  });
});

describe('company view (Phase 5 F9)', () => {
  const ORG = fixtureId(601);

  it('reads ?org= (a uuid) and lets it replace the team; malformed ids are ignored', () => {
    const state = parseInboxParams(
      new URLSearchParams({ view: 'open', team: TEAM, org: ORG.toUpperCase(), q: 'nvr' }),
    );
    expect(state).toEqual({ view: 'open', teamId: null, orgId: ORG, ticket: null, q: 'nvr' });
    expect(parseInboxParams(new URLSearchParams({ org: 'hamad' })).orgId).toBeNull();
  });

  it('keeps the view underneath the company in the URL and round-trips', () => {
    expect(inboxHref({ orgId: ORG })).toBe(`/console/inbox?org=${ORG}`);
    const state = { view: 'solved' as const, teamId: null, orgId: ORG, ticket: 'LG-4771', q: 'x' };
    const href = inboxHref(state);
    expect(href).toBe(`/console/inbox?view=solved&org=${ORG}&ticket=LG-4771&q=x`);
    expect(parseInboxParams(new URL(href, 'http://x').searchParams)).toEqual(state);
    expect(inboxHref({ view: 'risk', teamId: TEAM, orgId: ORG })).toBe(
      `/console/inbox?view=risk&org=${ORG}`,
    );
  });

  it('lists every ticket of the company (orgId, no view: all statuses) with the search and sort', () => {
    const state = parseInboxParams(new URLSearchParams({ view: 'p1', org: ORG, q: 'fw' }));
    expect(listFiltersFor(state, 'recent')).toEqual({ orgId: ORG, search: 'fw', sort: 'recent' });
  });

  it('clearing the company returns to the view it replaced', () => {
    window.history.replaceState(null, '', `/console/inbox?view=open&org=${ORG}&ticket=LG-4817`);
    updateInboxUrl({ orgId: null, ticket: null });
    expect(window.location.search).toBe('?view=open');
  });
});

describe('isSelectedTicket', () => {
  it('matches by normalised ref or id', () => {
    const ticket = { id: fixtureId(901), ref: 'LG-4771' };
    expect(isSelectedTicket('LG-4771', ticket)).toBe(true);
    expect(isSelectedTicket(fixtureId(901), ticket)).toBe(true);
    expect(isSelectedTicket('LG-4817', ticket)).toBe(false);
    expect(isSelectedTicket(null, ticket)).toBe(false);
  });
});

describe('updateInboxUrl', () => {
  it('patches the query string of the current page with push or replace', () => {
    window.history.replaceState(null, '', '/console/inbox?view=risk');
    const before = window.history.length;
    updateInboxUrl({ ticket: 'LG-4817' });
    expect(window.location.pathname + window.location.search).toBe(
      '/console/inbox?view=risk&ticket=LG-4817',
    );
    expect(window.history.length).toBe(before + 1);

    updateInboxUrl({ q: 'nvr', ticket: null }, 'replace');
    expect(window.location.search).toBe('?view=risk&q=nvr');
    expect(window.history.length).toBe(before + 1);
    expect(currentInboxState()).toEqual({
      view: 'risk',
      teamId: null,
      orgId: null,
      ticket: null,
      q: 'nvr',
    });
  });

  it('does nothing when the state is unchanged', () => {
    window.history.replaceState(null, '', '/console/inbox?ticket=LG-1');
    const before = window.history.length;
    updateInboxUrl({ ticket: 'LG-1' });
    expect(window.history.length).toBe(before);
  });
});
