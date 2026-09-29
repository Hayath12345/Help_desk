import type { MessageDto } from '@loons/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateThread, upsertThreadMessage } from '@/lib/tickets/cache';
import { ticketKeys } from '@/lib/tickets/keys';
import { loadThread } from '@/lib/tickets/queries';
import { IDS, fixtureId, makeDetail, makeMessage, makeSummary } from '@/lib/tickets/test-fixtures';
import type { ThreadMessage, TicketPages } from '@/lib/tickets/types';
import { RealtimeClient } from './client';
import { fakeSocketFactory, type FakeSocket } from './fake-socket';
import { connectRealtimeToCache } from './provider';

const api = vi.hoisted(() => ({ fetchAllMessages: vi.fn() }));
vi.mock('@/lib/tickets/api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

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
  return { client, queryClient, invalidate, socket, disconnect };
}

const thread = (qc: QueryClient) =>
  qc.getQueryData<ThreadMessage[]>(ticketKeys.messages(IDS.ticket));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  api.fetchAllMessages.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('realtime → query cache', () => {
  it('inserts new messages into loaded threads, deduplicated, and drops malformed ones', () => {
    const { queryClient, socket } = setup();
    const first = makeMessage();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), [first]);

    const reply = makeMessage({
      id: fixtureId(2),
      type: 'PUBLIC',
      body: 'On it',
      author: { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' },
      createdAt: '2026-09-23T12:05:00.000Z',
    });
    socket.receive('message:new', { ticketId: IDS.ticket, message: reply });
    socket.receive('message:new', { ticketId: IDS.ticket, message: reply });
    expect(thread(queryClient)?.map((m) => m.id)).toEqual([first.id, reply.id]);

    socket.receive('message:new', { ticketId: IDS.ticket, message: { id: 'nope' } });
    // Payload for another ticket than it claims: ignored.
    socket.receive('message:new', {
      ticketId: fixtureId(999),
      message: makeMessage({ id: fixtureId(3) }),
    });
    expect(thread(queryClient)).toHaveLength(2);

    // Threads nobody loaded are not created.
    const other = fixtureId(904);
    socket.receive('message:new', {
      ticketId: other,
      message: makeMessage({ id: fixtureId(4), ticketId: other }),
    });
    expect(queryClient.getQueryData(ticketKeys.messages(other))).toBeUndefined();
  });

  it('applies ticket:updated to the detail and lists, refetching a stale detail', async () => {
    const { queryClient, socket, invalidate } = setup();
    queryClient.setQueryData(ticketKeys.detail('LG-4771'), makeDetail());
    queryClient.setQueryData<TicketPages>(ticketKeys.list({ view: 'open' }), {
      pages: [{ items: [makeSummary()], nextCursor: null }],
      pageParams: [null],
    });
    const updated = makeSummary({
      status: 'PENDING',
      assignee: { id: IDS.staff, name: 'Maya Ruiz' },
      updatedAt: '2026-09-23T13:00:00.000Z',
    });
    socket.receive('ticket:updated', { ticket: updated });

    expect(queryClient.getQueryData<{ status: string }>(ticketKeys.detail('LG-4771'))?.status).toBe(
      'PENDING',
    );
    expect(
      queryClient.getQueryData<TicketPages>(ticketKeys.list({ view: 'open' }))?.pages[0]?.items[0]
        ?.assignee,
    ).toEqual({ id: IDS.staff, name: 'Maya Ruiz' });
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ticketKeys.details() }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.counts() });

    socket.receive('ticket:updated', { ticket: { id: 'bad' } });
  });

  it('debounces queue:updated into one list + counts refresh', async () => {
    const { socket, invalidate } = setup();
    for (let i = 0; i < 5; i += 1) {
      socket.receive('queue:updated', { teamId: 't', ticketId: IDS.ticket, reason: 'message' });
    }
    expect(invalidate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.counts() });
  });

  it('refetches the form configuration on config:updated', () => {
    const { socket, invalidate } = setup();
    socket.receive('config:updated', { scope: 'ticket-form' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.formConfig() });
  });

  it('after a reconnect, fetches what joined threads missed (after the last known id)', async () => {
    const { client, queryClient, socket, invalidate } = setup();
    const first = makeMessage();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), [first]);
    // The thread is on screen (an observer), so the catch-up fetches instead of invalidating.
    const observer = new QueryObserver(queryClient, {
      queryKey: ticketKeys.messages(IDS.ticket),
      queryFn: () => loadThread(queryClient, IDS.ticket),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    api.fetchAllMessages.mockResolvedValue([]);
    client.joinTicket(IDS.ticket);
    await vi.waitFor(() =>
      expect(api.fetchAllMessages).toHaveBeenCalledWith(IDS.ticket, { after: first.id }),
    );
    const missed = makeMessage({ id: fixtureId(5), createdAt: '2026-09-23T12:40:00.000Z' });
    api.fetchAllMessages.mockResolvedValueOnce([missed]);

    socket.transportClose();
    socket.accept();
    await vi.waitFor(() => expect(thread(queryClient)).toHaveLength(2));
    expect(api.fetchAllMessages).toHaveBeenLastCalledWith(IDS.ticket, { after: first.id });
    await vi.advanceTimersByTimeAsync(500);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.details() });
    unsubscribe();
  });

  it('stops updating the cache after cleanup', () => {
    const { queryClient, socket, disconnect } = setup();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), []);
    disconnect();
    socket.receive('message:new', { ticketId: IDS.ticket, message: makeMessage() });
    expect(thread(queryClient)).toEqual([]);
  });
});

describe('thread loads × realtime pushes and joins, in every order (P2-CC-3)', () => {
  const key = ticketKeys.messages(IDS.ticket);
  const m1 = makeMessage();
  const m2 = makeMessage({
    id: fixtureId(2002),
    body: 'On it, restarting the NVR.',
    author: { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' },
    createdAt: '2026-09-23T12:05:00.000Z',
  });
  const m3 = makeMessage({
    id: fixtureId(2003),
    body: 'Thanks',
    createdAt: '2026-09-23T12:06:00.000Z',
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  function live(options: { holdAcks?: boolean } = {}) {
    const { factory, sockets } = fakeSocketFactory();
    const client = new RealtimeClient({
      url: 'http://api.test',
      getToken: async () => 'token',
      createSocket: factory,
    });
    // The app's defaults: a thread stays fresh for 30 s (no refetch on remount).
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 30_000, retry: false } },
    });
    connectRealtimeToCache(client, queryClient);
    client.start();
    const socket = sockets[0] as FakeSocket;
    socket.accept();
    socket.holdAcks = options.holdAcks ?? false;
    /** A mounted `useMessages` (the thread on screen). */
    const view = () => {
      const observer = new QueryObserver<ThreadMessage[]>(queryClient, {
        queryKey: key,
        queryFn: ({ signal }) => loadThread(queryClient, IDS.ticket, signal),
      });
      return { observer, unsubscribe: observer.subscribe(() => undefined) };
    };
    const push = (message: MessageDto) =>
      socket.receive('message:new', { ticketId: IDS.ticket, message });
    const ids = () => thread(queryClient)?.map((m) => m.id);
    return { client, queryClient, socket, view, push, ids };
  }

  it('a push during a refetch survives the refetch (its snapshot predates the push)', async () => {
    const { view, push, ids } = live();
    api.fetchAllMessages.mockResolvedValueOnce([m1]);
    const { observer, unsubscribe } = view();
    await vi.waitFor(() => expect(ids()).toEqual([m1.id]));

    const refetch = deferred<MessageDto[]>();
    api.fetchAllMessages.mockReturnValueOnce(refetch.promise);
    const done = observer.refetch();
    push(m2);
    expect(ids()).toEqual([m1.id, m2.id]);
    refetch.resolve([m1]);
    await done;
    expect(ids()).toEqual([m1.id, m2.id]);
    unsubscribe();
  });

  it('a push during the first load is merged when the load finishes', async () => {
    const { queryClient, view, push, ids } = live();
    const load = deferred<MessageDto[]>();
    api.fetchAllMessages.mockReturnValueOnce(load.promise);
    const { unsubscribe } = view();
    push(m2);
    // Not written as the whole thread: the view keeps its loading state.
    expect(queryClient.getQueryState(key)?.status).toBe('pending');
    load.resolve([m1]);
    await vi.waitFor(() => expect(ids()).toEqual([m1.id, m2.id]));
    unsubscribe();
  });

  it('a push for a thread nobody loaded is left to its first load', async () => {
    const { queryClient, push, view, ids } = live();
    push(m2);
    expect(queryClient.getQueryState(key)).toBeUndefined();
    api.fetchAllMessages.mockResolvedValueOnce([m1, m2]);
    const { unsubscribe } = view();
    await vi.waitFor(() => expect(ids()).toEqual([m1.id, m2.id]));
    unsubscribe();
  });

  it('a join answered during the first load makes it fetch what was stored after its snapshot', async () => {
    const { client, socket, view, ids } = live({ holdAcks: true });
    const load = deferred<MessageDto[]>();
    api.fetchAllMessages.mockReturnValueOnce(load.promise).mockResolvedValueOnce([m2]);
    const { unsubscribe } = view();
    client.joinTicket(IDS.ticket);
    socket.deliverAcks(); // joined while the load is in flight
    // The load read the thread before the join; m2 was stored in between (never pushed).
    load.resolve([m1]);
    await vi.waitFor(() => expect(ids()).toEqual([m1.id, m2.id]));
    expect(api.fetchAllMessages).toHaveBeenLastCalledWith(IDS.ticket, {
      after: m1.id,
      signal: expect.any(AbortSignal),
    });
    unsubscribe();
  });

  it('a join answered before the first load starts needs no extra fetch', async () => {
    const { client, view, ids } = live();
    client.joinTicket(IDS.ticket);
    await flush();
    api.fetchAllMessages.mockResolvedValueOnce([m1]);
    const { unsubscribe } = view();
    await vi.waitFor(() => expect(ids()).toEqual([m1.id]));
    await flush();
    expect(api.fetchAllMessages).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('joining a thread already on screen (still fresh in the cache) fetches what it missed', async () => {
    const { client, queryClient, view, ids } = live();
    queryClient.setQueryData(key, [m1]);
    const { unsubscribe } = view(); // fresh: no refetch on mount
    api.fetchAllMessages.mockResolvedValueOnce([m2]);
    client.joinTicket(IDS.ticket);
    await vi.waitFor(() => expect(ids()).toEqual([m1.id, m2.id]));
    expect(api.fetchAllMessages).toHaveBeenCalledWith(IDS.ticket, { after: m1.id });
    unsubscribe();
  });

  it('joining a cached thread that is off screen marks it stale instead of fetching', async () => {
    const { client, queryClient } = live();
    queryClient.setQueryData(key, [m1]);
    client.joinTicket(IDS.ticket);
    await flush();
    expect(api.fetchAllMessages).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('after a reconnect the catch-up waits for the re-join, then merges', async () => {
    const { client, socket, queryClient, view, push, ids } = live({ holdAcks: true });
    queryClient.setQueryData(key, [m1]);
    const { unsubscribe } = view();
    api.fetchAllMessages.mockResolvedValue([]);
    client.joinTicket(IDS.ticket);
    socket.deliverAcks();
    await vi.waitFor(() => expect(api.fetchAllMessages).toHaveBeenCalledTimes(1));

    socket.transportClose();
    api.fetchAllMessages.mockResolvedValueOnce([m2]);
    socket.accept();
    await flush();
    expect(api.fetchAllMessages).toHaveBeenCalledTimes(1); // not before the room is joined again
    socket.deliverAcks();
    push(m3); // pushed right after the join, before the catch-up answers
    await vi.waitFor(() => expect(ids()).toEqual([m1.id, m2.id, m3.id]));
    unsubscribe();
  });

  it('parked pushes survive a failed first load and join the retry', async () => {
    const { queryClient, view, push, ids } = live();
    api.fetchAllMessages.mockRejectedValueOnce(new Error('offline'));
    const { observer, unsubscribe } = view();
    push(m2);
    await vi.waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('error'));
    api.fetchAllMessages.mockResolvedValueOnce([m1]);
    await observer.refetch();
    expect(ids()).toEqual([m1.id, m2.id]);
    unsubscribe();
  });

  it('updateThread writes loaded threads directly and parks the others', () => {
    const { queryClient } = live();
    updateThread(queryClient, IDS.ticket, (list) => upsertThreadMessage(list, m2), 'if-tracked');
    expect(queryClient.getQueryData(key)).toBeUndefined(); // nobody tracks it: dropped
    updateThread(queryClient, IDS.ticket, (list) => upsertThreadMessage(list, m2));
    expect(queryClient.getQueryData(key)).toBeUndefined(); // parked, not written
    queryClient.setQueryData(key, [m1]);
    updateThread(queryClient, IDS.ticket, (list) => upsertThreadMessage(list, m3), 'if-tracked');
    expect(thread(queryClient)?.map((m) => m.id)).toEqual([m1.id, m3.id]);
  });
});
