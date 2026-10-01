import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerKeys } from '@/lib/customers/keys';
import { RealtimeClient } from '@/lib/realtime/client';
import { queryKeysForConfigScope } from '@/lib/realtime/config-scopes';
import { fakeSocketFactory, type FakeSocket } from '@/lib/realtime/fake-socket';
import {
  VIEWS_REFRESH_DEBOUNCE_MS,
  VIEWS_REFRESH_MAX_WAIT_MS,
  connectRealtimeToCache,
} from '@/lib/realtime/provider';
import { ticketKeys } from '@/lib/tickets/keys';
import { IDS } from '@/lib/tickets/test-fixtures';
import { reportKeys } from './keys';

// Live Reports and Customers (Phase 5 F16): their own query-key prefixes (never under
// ['tickets', 'list']), refetched after queue changes (debounced), after a reconnect and on the
// config scopes that change what they show.

function setup() {
  const { factory, sockets } = fakeSocketFactory();
  const client = new RealtimeClient({
    url: 'http://api.test',
    getToken: async () => 'token',
    createSocket: factory,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const disconnect = connectRealtimeToCache(client, queryClient);
  client.start();
  const socket = sockets[0] as FakeSocket;
  socket.accept();
  return { invalidate, socket, disconnect };
}

const refreshed = (invalidate: ReturnType<typeof setup>['invalidate'], key: readonly unknown[]) =>
  invalidate.mock.calls.filter(
    ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(key),
  ).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

describe('reports and customers stay live', () => {
  it('keeps their keys out of the ticket lists', () => {
    expect(reportKeys.summary('30d').slice(0, 2)).not.toEqual(ticketKeys.lists());
    expect(customerKeys.list('qnb')[0]).toBe('customers');
    expect(reportKeys.summary('7d')).toEqual(['reports', 'summary', '7d']);
  });

  it('refetch once per burst of queue:updated (a bulk action emits one per ticket)', async () => {
    const { socket, invalidate } = setup();
    for (let i = 0; i < 50; i += 1) {
      socket.receive('queue:updated', { teamId: 't', ticketId: IDS.ticket, reason: 'updated' });
    }
    await vi.advanceTimersByTimeAsync(VIEWS_REFRESH_DEBOUNCE_MS - 1);
    expect(refreshed(invalidate, reportKeys.all)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshed(invalidate, reportKeys.all)).toBe(1);
    expect(refreshed(invalidate, customerKeys.lists())).toBe(1);
    // The company-view title is config (form-context), not queue data.
    expect(refreshed(invalidate, customerKeys.all)).toBe(0);
  });

  it('keep refreshing under steady queue:updated traffic (at least every 5 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { socket, invalidate } = setup();
    // One event every 800 ms for 11.2 s: the 1 s debounce alone would never fire (authz gap #8).
    for (let i = 0; i < 14; i += 1) {
      socket.receive('queue:updated', { teamId: 't', ticketId: IDS.ticket, reason: 'updated' });
      await vi.advanceTimersByTimeAsync(800);
    }
    expect(refreshed(invalidate, reportKeys.all)).toBeGreaterThanOrEqual(2);
    expect(refreshed(invalidate, customerKeys.lists())).toBeGreaterThanOrEqual(2);
    expect(VIEWS_REFRESH_MAX_WAIT_MS).toBeLessThanOrEqual(5_000);
  });

  it('refetch after a reconnect', async () => {
    const { socket, invalidate } = setup();
    socket.transportClose();
    socket.accept();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(VIEWS_REFRESH_DEBOUNCE_MS);
      expect(refreshed(invalidate, reportKeys.all)).toBe(1);
    });
    expect(refreshed(invalidate, customerKeys.lists())).toBe(1);
  });

  it('stop after cleanup', async () => {
    const { socket, invalidate, disconnect } = setup();
    socket.receive('queue:updated', { teamId: 't', ticketId: IDS.ticket, reason: 'updated' });
    disconnect();
    await vi.advanceTimersByTimeAsync(VIEWS_REFRESH_DEBOUNCE_MS);
    expect(refreshed(invalidate, reportKeys.all)).toBe(0);
  });

  it('follow the config scopes that change them', () => {
    const has = (scope: Parameters<typeof queryKeysForConfigScope>[0], key: readonly unknown[]) =>
      queryKeysForConfigScope(scope).some((k) => JSON.stringify(k) === JSON.stringify(key));
    // Category labels / archived categories; business time zone and hours.
    expect(has('ticket-form', reportKeys.all)).toBe(true);
    expect(has('calendar', reportKeys.all)).toBe(true);
    // Organisations and contracts: the customer rows and the company-view title.
    expect(has('form-context', customerKeys.all)).toBe(true);
    expect(has('macros', reportKeys.all)).toBe(false);
    expect(has('macros', customerKeys.all)).toBe(false);
  });

  it('config:updated form-context refetches the customers', () => {
    const { socket, invalidate } = setup();
    socket.receive('config:updated', { scope: 'form-context', version: 7 });
    expect(refreshed(invalidate, customerKeys.all)).toBe(1);
    socket.receive('config:updated', { scope: 'calendar', version: 8 });
    expect(refreshed(invalidate, reportKeys.all)).toBe(1);
  });
});
