// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import enErrors from '@/messages/en/errors.json';
import enTickets from '@/messages/en/tickets.json';
import enValidation from '@/messages/en/validation.json';
import { applyTicketSummary, upsertThreadMessage } from './cache';
import { ticketKeys } from './keys';
import { useCreateTicket, useSendMessage, useUpdateTicket } from './mutations';
import { useMessages, useTicket } from './queries';
import { IDS, fixtureId, makeDetail, makeMessage, makeSummary } from './test-fixtures';
import type { ThreadMessage, TicketPages } from './types';
import { ViewerProvider } from './viewer';

const api = vi.hoisted(() => ({
  postMessage: vi.fn(),
  updateTicket: vi.fn(),
  createTicket: vi.fn(),
  fetchAllMessages: vi.fn(),
  fetchTicket: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal()), ...api }));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const CLIENT = { id: IDS.requester, name: 'Dr. Aisha Al-Kuwari', role: 'CLIENT' as const };

function setup(viewer = CLIENT) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="en"
        timeZone="UTC"
        messages={{ tickets: enTickets, errors: enErrors, validation: enValidation }}
      >
        <ViewerProvider viewer={viewer}>{children}</ViewerProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const thread = (qc: QueryClient) =>
  qc.getQueryData<ThreadMessage[]>(ticketKeys.messages(IDS.ticket)) ?? [];

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  toast.error.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useSendMessage', () => {
  it('appends a pending message, predicts the status and swaps in the server message', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), [makeMessage()]);
    queryClient.setQueryData(ticketKeys.detail('LG-4771'), makeDetail({ status: 'SOLVED' }));
    const call = deferred<{
      message: ReturnType<typeof makeMessage>;
      ticket: ReturnType<typeof makeSummary>;
    }>();
    api.postMessage.mockReturnValueOnce(call.promise);

    const { result } = renderHook(() => useSendMessage(IDS.ticket), { wrapper });
    let tempId = '';
    act(() => {
      tempId = result.current.send({ type: 'PUBLIC', body: '  Still broken.  ' });
    });

    await waitFor(() => expect(thread(queryClient)).toHaveLength(2));
    const pending = thread(queryClient)[1]!;
    expect(pending).toMatchObject({
      id: tempId,
      clientTempId: tempId,
      body: 'Still broken.',
      author: CLIENT,
      local: { status: 'pending' },
    });
    // A client reply on a solved ticket reopens it (statusAfterMessage), before the server answers.
    expect(queryClient.getQueryData<{ status: string }>(ticketKeys.detail('LG-4771'))?.status).toBe(
      'OPEN',
    );
    expect(api.postMessage).toHaveBeenCalledWith(IDS.ticket, {
      type: 'PUBLIC',
      body: '  Still broken.  ',
      clientTempId: tempId,
      attachmentIds: [],
      andSolve: false,
    });

    // The realtime copy arrives first…
    const stored = makeMessage({
      id: fixtureId(2000),
      clientTempId: tempId,
      body: 'Still broken.',
      createdAt: '2026-09-23T12:30:00.000Z',
    });
    act(() => {
      queryClient.setQueryData<ThreadMessage[]>(ticketKeys.messages(IDS.ticket), (old) =>
        upsertThreadMessage(old, stored),
      );
    });
    // …then the POST answer: still one copy, no pending bubble left.
    await act(async () => {
      call.resolve({
        message: stored,
        ticket: makeSummary({ status: 'OPEN', updatedAt: '2026-09-23T12:30:00.000Z' }),
      });
      await call.promise;
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(thread(queryClient).map((m) => m.id)).toEqual([makeMessage().id, stored.id]);
    expect(thread(queryClient).some((m) => m.local)).toBe(false);
  });

  it('marks a failed message, rolls the status back, and retries with the same clientTempId', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), []);
    queryClient.setQueryData(ticketKeys.detail('LG-4771'), makeDetail({ status: 'SOLVED' }));
    api.postMessage.mockRejectedValueOnce(new ApiRequestError(0, 'INTERNAL', 'offline'));

    const { result } = renderHook(() => useSendMessage(IDS.ticket), { wrapper });
    let tempId = '';
    act(() => {
      tempId = result.current.send({ type: 'PUBLIC', body: 'Hello' });
    });
    await waitFor(() => expect(thread(queryClient)[0]?.local?.status).toBe('failed'));
    expect(queryClient.getQueryData<{ status: string }>(ticketKeys.detail('LG-4771'))?.status).toBe(
      'SOLVED',
    );
    expect(toast.error).toHaveBeenCalledWith(
      enTickets.toast.sendFailed.replace('{reason}', enErrors.INTERNAL),
    );

    api.postMessage.mockResolvedValueOnce({
      message: makeMessage({ id: fixtureId(3000), clientTempId: tempId, body: 'Hello' }),
      ticket: makeSummary({ updatedAt: '2026-09-23T13:00:00.000Z' }),
    });
    act(() => result.current.retry(thread(queryClient)[0]!));
    expect(api.postMessage).toHaveBeenLastCalledWith(
      IDS.ticket,
      expect.objectContaining({ clientTempId: tempId, body: 'Hello' }),
    );
    await waitFor(() =>
      expect(thread(queryClient)).toEqual([expect.objectContaining({ id: fixtureId(3000) })]),
    );
  });

  describe('sending while the thread is still loading keeps the history (F3)', () => {
    const history = [
      makeMessage({ id: fixtureId(1001), body: 'Description' }),
      makeMessage({
        id: fixtureId(1002),
        body: 'Agent reply',
        author: { id: IDS.staff, name: 'Maya Ruiz', role: 'AGENT' },
        createdAt: '2026-09-23T12:05:00.000Z',
      }),
    ];
    const storedReply = (clientTempId: string) =>
      makeMessage({
        id: fixtureId(1003),
        body: 'Quick reply',
        clientTempId,
        createdAt: '2026-09-23T12:10:00.000Z',
      });

    function mountThread() {
      const { queryClient, wrapper } = setup();
      queryClient.setQueryData(ticketKeys.detail('LG-4771'), makeDetail({ status: 'OPEN' }));
      const load = deferred<ReturnType<typeof makeMessage>[]>();
      api.fetchAllMessages.mockReturnValueOnce(load.promise);
      const post = deferred<{
        message: ReturnType<typeof makeMessage>;
        ticket: ReturnType<typeof makeSummary>;
      }>();
      api.postMessage.mockReturnValueOnce(post.promise);
      const hook = renderHook(
        () => ({ messages: useMessages(IDS.ticket), sender: useSendMessage(IDS.ticket) }),
        { wrapper },
      );
      return { queryClient, hook, load, post };
    }
    const bodies = (hook: ReturnType<typeof mountThread>['hook']) =>
      (hook.result.current.messages.data ?? []).map((m) => `${m.body}${m.local ? '*' : ''}`);

    it('the server answers before the history arrives', async () => {
      const { hook, load, post } = mountThread();
      let tempId = '';
      await act(async () => {
        tempId = hook.result.current.sender.send({ type: 'PUBLIC', body: 'Quick reply' });
        await Promise.resolve(); // onMutate runs
      });
      await waitFor(() => expect(api.postMessage).toHaveBeenCalled());
      // The thread stays in its loading state: never "loaded" with only the new message.
      expect(hook.result.current.messages.isPending).toBe(true);
      expect(hook.result.current.messages.data).toBeUndefined();
      await act(async () => {
        post.resolve({ message: storedReply(tempId), ticket: makeSummary() });
        await post.promise;
      });
      expect(hook.result.current.messages.isPending).toBe(true);
      await act(async () => {
        load.resolve(history); // read before the reply was stored
        await load.promise;
      });
      await waitFor(() =>
        expect(bodies(hook)).toEqual(['Description', 'Agent reply', 'Quick reply']),
      );
    });

    it('the history arrives first, then the server answer', async () => {
      const { hook, load, post } = mountThread();
      let tempId = '';
      act(() => {
        tempId = hook.result.current.sender.send({ type: 'PUBLIC', body: 'Quick reply' });
      });
      await act(async () => {
        load.resolve(history);
        await load.promise;
      });
      await waitFor(() =>
        expect(bodies(hook)).toEqual(['Description', 'Agent reply', 'Quick reply*']),
      );
      await act(async () => {
        post.resolve({ message: storedReply(tempId), ticket: makeSummary() });
        await post.promise;
      });
      await waitFor(() =>
        expect(bodies(hook)).toEqual(['Description', 'Agent reply', 'Quick reply']),
      );
    });

    it('a failed send during the load stays in the thread as failed', async () => {
      const { hook, load, post } = mountThread();
      act(() => {
        hook.result.current.sender.send({ type: 'PUBLIC', body: 'Quick reply' });
      });
      await act(async () => {
        post.reject(new ApiRequestError(0, 'INTERNAL', 'offline'));
        await post.promise.catch(() => undefined);
      });
      await act(async () => {
        load.resolve(history);
        await load.promise;
      });
      await waitFor(() =>
        expect(bodies(hook)).toEqual(['Description', 'Agent reply', 'Quick reply*']),
      );
      expect(hook.result.current.messages.data?.at(-1)?.local?.status).toBe('failed');
    });
  });

  it('explains a closed ticket (409) and lets the user discard the message', async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(ticketKeys.messages(IDS.ticket), []);
    api.postMessage.mockRejectedValueOnce(new ApiRequestError(409, 'CONFLICT', 'closed'));
    const { result } = renderHook(() => useSendMessage(IDS.ticket), { wrapper });
    act(() => {
      result.current.send({ type: 'PUBLIC', body: 'Hello' });
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(enTickets.toast.closed));
    act(() => result.current.discard(thread(queryClient)[0]!));
    expect(thread(queryClient)).toEqual([]);
  });
});

describe('useUpdateTicket', () => {
  function seed(queryClient: QueryClient) {
    queryClient.setQueryData(ticketKeys.detail('LG-4771'), makeDetail());
    queryClient.setQueryData<TicketPages>(ticketKeys.list({ view: 'open' }), {
      pages: [{ items: [makeSummary()], nextCursor: null }],
      pageParams: [null],
    });
    queryClient.setQueryData(ticketKeys.teams(), [
      { ...makeSummary().team, members: [{ id: IDS.staff, name: 'Priya Shah', role: 'AGENT' }] },
    ]);
  }
  const row = (qc: QueryClient) =>
    qc.getQueryData<TicketPages>(ticketKeys.list({ view: 'open' }))?.pages[0]?.items[0];

  it('updates the detail and list rows optimistically, then applies the server answer', async () => {
    const { queryClient, wrapper } = setup();
    seed(queryClient);
    const call = deferred<ReturnType<typeof makeDetail>>();
    api.updateTicket.mockReturnValueOnce(call.promise);
    const { result } = renderHook(() => useUpdateTicket(), { wrapper });

    act(() => {
      result.current.mutate({
        ticketId: IDS.ticket,
        patch: { status: 'SOLVED', priority: 'P3', assigneeId: IDS.staff },
      });
    });
    await waitFor(() => expect(row(queryClient)?.status).toBe('SOLVED'));
    expect(row(queryClient)).toMatchObject({
      priority: 'P3',
      assignee: { id: IDS.staff, name: 'Priya Shah' },
    });
    expect(row(queryClient)?.solvedAt).not.toBeNull();

    await act(async () => {
      call.resolve(
        makeDetail({ status: 'SOLVED', priority: 'P3', updatedAt: '2026-09-23T15:00:00.000Z' }),
      );
      await call.promise;
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ updatedAt: string }>(ticketKeys.detail('LG-4771'))?.updatedAt,
      ).toBe('2026-09-23T15:00:00.000Z'),
    );
  });

  it('rolls back and explains why when the API refuses', async () => {
    const { queryClient, wrapper } = setup();
    seed(queryClient);
    api.updateTicket.mockRejectedValueOnce(new ApiRequestError(403, 'FORBIDDEN', 'no'));
    const { result } = renderHook(() => useUpdateTicket(), { wrapper });
    act(() => {
      result.current.mutate({ ticketId: IDS.ticket, patch: { priority: 'P4' } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(row(queryClient)?.priority).toBe('P1');
    expect(
      queryClient.getQueryData<{ priority: string }>(ticketKeys.detail('LG-4771'))?.priority,
    ).toBe('P1');
    expect(toast.error).toHaveBeenCalledWith(
      enTickets.toast.updateFailed.replace('{reason}', enErrors.FORBIDDEN),
    );
  });

  it("never cancels another ticket's first load (F2)", async () => {
    const { queryClient, wrapper } = setup();
    seed(queryClient);
    const other = makeDetail({ id: fixtureId(902), number: 4772, ref: 'LG-4772' });
    const load = deferred<ReturnType<typeof makeDetail>>();
    api.fetchTicket.mockReturnValueOnce(load.promise);
    api.updateTicket.mockResolvedValueOnce(
      makeDetail({ status: 'PENDING', updatedAt: '2026-09-23T15:00:00.000Z' }),
    );
    const { result } = renderHook(
      () => ({ detail: useTicket('LG-4772'), update: useUpdateTicket() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.fetchStatus).toBe('fetching'));
    // e.g. a macro's follow-up PATCH on the previous ticket while the next one opens.
    await act(async () => {
      await result.current.update.mutateAsync({
        ticketId: IDS.ticket,
        patch: { status: 'PENDING' },
      });
    });
    await act(async () => {
      load.resolve(other);
      await load.promise;
    });
    await waitFor(() => expect(result.current.detail.data?.id).toBe(other.id));
    expect(api.fetchTicket).toHaveBeenCalledTimes(1);
    expect(row(queryClient)?.status).toBe('PENDING');
  });

  it('a failed PATCH keeps what realtime changed meanwhile, then reloads the detail (F4)', async () => {
    const { queryClient, wrapper } = setup();
    seed(queryClient);
    api.fetchTicket.mockResolvedValue(
      makeDetail({
        status: 'SOLVED',
        preview: 'Working again, thanks',
        updatedAt: '2026-09-23T13:00:00.000Z',
      }),
    );
    const call = deferred<ReturnType<typeof makeDetail>>();
    api.updateTicket.mockReturnValueOnce(call.promise);
    const { result } = renderHook(
      () => ({ detail: useTicket('LG-4771'), update: useUpdateTicket() }),
      { wrapper },
    );
    act(() => {
      result.current.update.mutate({ ticketId: IDS.ticket, patch: { priority: 'P3' } });
    });
    await waitFor(() => expect(result.current.detail.data?.priority).toBe('P3'));
    // ticket:updated: the client solved it while the PATCH was in flight.
    act(() => {
      applyTicketSummary(
        queryClient,
        makeSummary({
          status: 'SOLVED',
          preview: 'Working again, thanks',
          updatedAt: '2026-09-23T13:00:00.000Z',
        }),
      );
    });
    await act(async () => {
      call.reject(new ApiRequestError(500, 'INTERNAL', 'boom'));
      await call.promise.catch(() => undefined);
    });
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    expect(result.current.detail.data).toMatchObject({
      status: 'SOLVED',
      priority: 'P1',
      preview: 'Working again, thanks',
    });
    expect(row(queryClient)).toMatchObject({ status: 'SOLVED', priority: 'P1' });
    await waitFor(() => expect(api.fetchTicket).toHaveBeenCalledWith('LG-4771', expect.anything()));
  });
});

describe('useCreateTicket', () => {
  it('caches the new ticket and refreshes lists and counts', async () => {
    const { queryClient, wrapper } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    api.createTicket.mockResolvedValueOnce(makeDetail({ number: 4900, ref: 'LG-4900' }));
    const { result } = renderHook(() => useCreateTicket(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({} as never);
    });
    expect(queryClient.getQueryData(ticketKeys.detail('LG-4900'))).toMatchObject({ number: 4900 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.lists() });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.counts() });
  });
});
