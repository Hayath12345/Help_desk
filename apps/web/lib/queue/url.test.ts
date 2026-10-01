import { QUEUE_TABS, QUEUE_TAB_SORTS, QUEUE_TAB_VIEWS } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import {
  hasQueueFilters,
  parseQueueParams,
  queueFiltersFor,
  queueHref,
  queueListFiltersFor,
  queueQuery,
  queueTicketHref,
  type QueueState,
} from './url';

const CATEGORY = '00000000-0000-4000-8000-000000000207';
const AGENT = '00000000-0000-4000-8000-000000000803';
const params = (qs: string) => new URLSearchParams(qs);
const DEFAULT: QueueState = {
  tab: 'open',
  priority: null,
  categoryId: null,
  assigneeId: null,
  q: '',
};

describe('Team queue URL state', () => {
  it('reads tab, filters and search, and falls back to the defaults for anything malformed', () => {
    expect(parseQueueParams(null)).toEqual(DEFAULT);
    expect(
      parseQueueParams(
        params(
          `tab=breaching&priority=P2&category=${CATEGORY.toUpperCase()}&assignee=${AGENT}&q=%20nvr%20`,
        ),
      ),
    ).toEqual({
      tab: 'breaching',
      priority: 'P2',
      categoryId: CATEGORY,
      assigneeId: AGENT,
      q: 'nvr',
    });
    expect(parseQueueParams(params('assignee=none'))).toMatchObject({ assigneeId: 'none' });
    expect(parseQueueParams(params('tab=mine&priority=P9&category=cctv&assignee=nobody'))).toEqual(
      DEFAULT,
    );
    expect(parseQueueParams(params(`q=${'x'.repeat(150)}`)).q).toHaveLength(100);
  });

  it('writes a stable query string without defaults (round trip)', () => {
    expect(queueQuery(DEFAULT)).toBe('');
    const state: QueueState = {
      tab: 'solved',
      priority: 'P1',
      categoryId: CATEGORY,
      assigneeId: 'none',
      q: 'turnstile',
    };
    const qs = queueQuery(state);
    expect(qs).toBe(`?tab=solved&priority=P1&category=${CATEGORY}&assignee=none&q=turnstile`);
    expect(parseQueueParams(params(qs.slice(1)))).toEqual(state);
    expect(queueHref({ tab: 'unassigned' })).toBe('/console/queue?tab=unassigned');
    expect(queueHref()).toBe('/console/queue');
  });

  it('sends the filters and search to every call, plus the tab’s view and sort to the list', () => {
    const state: QueueState = { ...DEFAULT, priority: 'P3', assigneeId: 'none', q: 'av' };
    expect(queueFiltersFor(state)).toEqual({
      priority: 'P3',
      categoryId: undefined,
      assigneeId: 'none',
      search: 'av',
    });
    for (const tab of QUEUE_TABS) {
      expect(queueListFiltersFor({ ...state, tab })).toEqual({
        ...queueFiltersFor(state),
        view: QUEUE_TAB_VIEWS[tab],
        sort: QUEUE_TAB_SORTS[tab],
      });
    }
    expect(queueListFiltersFor({ ...DEFAULT, tab: 'breaching' })).toMatchObject({
      view: 'risk',
      sort: 'priority',
    });
    expect(queueListFiltersFor({ ...DEFAULT, tab: 'solved' })).toMatchObject({
      view: 'solved',
      sort: 'recent',
    });
    expect(hasQueueFilters(DEFAULT)).toBe(false);
    expect(hasQueueFilters({ ...DEFAULT, tab: 'solved' })).toBe(false);
    expect(hasQueueFilters({ ...DEFAULT, q: 'x' })).toBe(true);
  });

  it('opens solved and closed tickets in the Inbox Solved view, the others in All open', () => {
    expect(queueTicketHref({ ref: 'LG-4771', status: 'OPEN' })).toBe(
      '/console/inbox?view=open&ticket=LG-4771',
    );
    expect(queueTicketHref({ ref: 'LG-4790', status: 'NEW' })).toBe(
      '/console/inbox?view=open&ticket=LG-4790',
    );
    expect(queueTicketHref({ ref: 'LG-4809', status: 'PENDING' })).toBe(
      '/console/inbox?view=open&ticket=LG-4809',
    );
    expect(queueTicketHref({ ref: 'LG-4752', status: 'SOLVED' })).toBe(
      '/console/inbox?view=solved&ticket=LG-4752',
    );
    expect(queueTicketHref({ ref: 'LG-4700', status: 'CLOSED' })).toBe(
      '/console/inbox?view=solved&ticket=LG-4700',
    );
  });
});
