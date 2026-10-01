import { CONFIG_SCOPES, type BulkTicketsInput } from '@loons/shared';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { RealtimeClient } from '@/lib/realtime/client';
import { RECONNECT_CONFIG_KEYS, queryKeysForConfigScope } from '@/lib/realtime/config-scopes';
import { fakeSocketFactory, type FakeSocket } from '@/lib/realtime/fake-socket';
import { connectRealtimeToCache } from '@/lib/realtime/provider';
import { ticketKeys } from '@/lib/tickets/keys';
import { fixtureId } from '@/lib/tickets/test-fixtures';
import { runBulkTickets } from './api';
import { QUEUE_LIVE_KEYS, queueKeys } from './keys';
import { invalidateAfterBulk } from './queries';

const http = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api/browser', () => ({
  apiClient: { post: http.post, get: vi.fn() },
  getApiToken: vi.fn(async () => 'token'),
}));

const same = (a: QueryKey, b: QueryKey) => JSON.stringify(a) === JSON.stringify(b);
const has = (keys: readonly QueryKey[], key: QueryKey) => keys.some((k) => same(k, key));

describe('bulk requests (F6)', () => {
  beforeEach(() => {
    http.post.mockReset();
  });

  it('sends at most 50 ids per request and keeps going when one request fails', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => fixtureId(10_000 + i));
    const failure = new ApiRequestError(429, 'RATE_LIMITED', 'Slow down');
    http.post.mockImplementation(async (_path: string, body: BulkTicketsInput) => {
      if (body.ids[0] === ids[50]) throw failure;
      return {
        results: body.ids.map((id) => ({ id, ok: true, changed: true })),
        updated: body.ids.length,
        failed: 0,
      };
    });
    const result = await runBulkTickets(ids, 'solve');
    expect(
      http.post.mock.calls.map(([path, body]) => [path, body.ids.length, body.action]),
    ).toEqual([
      ['/tickets/bulk', 50, 'solve'],
      ['/tickets/bulk', 50, 'solve'],
      ['/tickets/bulk', 20, 'solve'],
    ]);
    expect(result.updated).toBe(70);
    expect(result.failed).toBe(50);
    expect(result.results.map((r) => r.id)).toEqual(ids);
    expect(result.results[50]).toEqual({ id: ids[50], ok: false, requestError: failure });
  });

  it('refreshes the queue, the Inbox lists and counts, and only the touched details', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const touched = fixtureId(1);
    queryClient.setQueryData(ticketKeys.detail('LG-1'), { id: touched });
    queryClient.setQueryData(ticketKeys.detail('LG-2'), { id: fixtureId(2) });
    invalidateAfterBulk(queryClient, [touched]);
    for (const queryKey of QUEUE_LIVE_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.counts() });
    const details = invalidate.mock.calls.find(([filters]) =>
      same(filters!.queryKey!, ticketKeys.details()),
    )![0]!;
    const cache = queryClient.getQueryCache();
    const matches = (ref: string) =>
      details.predicate!(cache.find({ queryKey: ticketKeys.detail(ref), exact: true })!);
    expect(matches('LG-1')).toBe(true);
    expect(matches('LG-2')).toBe(false);
  });
});

describe('Team queue live data (F16)', () => {
  it('config:updated refreshes the Category filter (ticket-form) and the cards (teams, staff)', () => {
    for (const scope of CONFIG_SCOPES) {
      const keys = queryKeysForConfigScope(scope);
      expect(has(keys, queueKeys.filterOptions()), scope).toBe(scope === 'ticket-form');
      expect(has(keys, queueKeys.workload()), scope).toBe(scope === 'teams' || scope === 'staff');
    }
    expect(has(RECONNECT_CONFIG_KEYS, queueKeys.filterOptions())).toBe(true);
  });

  describe('through the realtime provider', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => vi.useRealTimers());

    function setup() {
      const { factory, sockets } = fakeSocketFactory();
      const client = new RealtimeClient({
        url: 'http://api.test',
        getToken: async () => 'token',
        createSocket: factory,
      });
      const queryClient = new QueryClient();
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
      const disconnect = connectRealtimeToCache(client, queryClient);
      client.start();
      const socket = sockets[0] as FakeSocket;
      socket.accept();
      return { invalidate, socket, disconnect };
    }

    it('refetches the queue once per queue:updated burst (a bulk action emits one per ticket)', async () => {
      const { socket, invalidate } = setup();
      for (let i = 0; i < 50; i += 1) {
        socket.receive('queue:updated', { teamId: 't', ticketId: fixtureId(i), reason: 'update' });
      }
      await vi.advanceTimersByTimeAsync(400);
      for (const queryKey of QUEUE_LIVE_KEYS) {
        expect(invalidate.mock.calls.filter(([f]) => same(f!.queryKey!, queryKey))).toHaveLength(1);
      }
    });

    it('refetches the queue and its filter options after a reconnect', async () => {
      const { socket, invalidate } = setup();
      socket.transportClose();
      socket.accept();
      await vi.waitFor(() =>
        expect(invalidate).toHaveBeenCalledWith({ queryKey: queueKeys.filterOptions() }),
      );
      await vi.advanceTimersByTimeAsync(400);
      for (const queryKey of QUEUE_LIVE_KEYS) expect(invalidate).toHaveBeenCalledWith({ queryKey });
    });
  });
});
