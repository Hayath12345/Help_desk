// @vitest-environment jsdom
import { MAX_TICKET_ROOMS_PER_SOCKET } from '@loons/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerProvider } from '@/lib/tickets/viewer';
import { RealtimeClient } from './client';
import { fakeSocketFactory, type FakeSocket } from './fake-socket';
import {
  TYPING_IDLE_MS,
  TYPING_REMOTE_TTL_MS,
  TYPING_THROTTLE_MS,
  useRealtimeStatus,
  useTicketRoom,
  useTicketRooms,
  useTyping,
} from './hooks';
import { RealtimeProvider } from './provider';

const holder = vi.hoisted(() => ({ client: null as RealtimeClient | null }));
vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal()),
  getRealtimeClient: () => holder.client,
}));

const TICKET = '00000000-0000-4000-8000-000000000901';
const ME = {
  id: '00000000-0000-4000-8000-000000000801',
  name: 'Maya Ruiz',
  role: 'AGENT' as const,
};

let sockets: FakeSocket[] = [];
const socket = () => sockets[sockets.length - 1]!;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ViewerProvider viewer={ME}>
        <RealtimeProvider>{children}</RealtimeProvider>
      </ViewerProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const fake = fakeSocketFactory();
  sockets = fake.sockets;
  holder.client = new RealtimeClient({
    url: 'http://api.test',
    getToken: async () => 'token',
    createSocket: fake.factory,
    idleCloseMs: 10,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTicketRoom / useRealtimeStatus', () => {
  it('joins while mounted and leaves on unmount; exposes the connection status', async () => {
    const { result, unmount } = renderHook(
      () => {
        useTicketRoom(TICKET);
        return useRealtimeStatus();
      },
      { wrapper },
    );
    expect(result.current).toBe('connecting');
    act(() => socket().accept());
    expect(result.current).toBe('connected');
    expect(socket().eventsNamed('ticket:join')).toEqual([{ ticketId: TICKET }]);
    unmount();
    await Promise.resolve(); // the leave is sent a microtask later (a re-join would cancel it)
    expect(socket().eventsNamed('ticket:leave')).toEqual([{ ticketId: TICKET }]);
  });
});

describe('useTicketRooms', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => id(from + i));

  it('a list whose rows change at the rooms cap leaves the dropped rows before joining the new ones', async () => {
    const { rerender } = renderHook(({ ids }) => useTicketRooms(ids), {
      wrapper,
      initialProps: { ids: range(1, MAX_TICKET_ROOMS_PER_SOCKET) },
    });
    act(() => socket().accept());
    socket().maxRooms = MAX_TICKET_ROOMS_PER_SOCKET; // the server's cap
    expect(socket().serverRooms.size).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
    socket().emitted.length = 0;

    // A new ticket comes first; the oldest row drops out.
    rerender({ ids: [id(99), ...range(1, MAX_TICKET_ROOMS_PER_SOCKET - 1)] });
    await act(async () => {
      await Promise.resolve();
    });
    const sent = socket().emitted.map(
      (e) => `${e.event} ${(e.payload as { ticketId: string }).ticketId}`,
    );
    expect(sent).toEqual([
      `ticket:leave ${id(MAX_TICKET_ROOMS_PER_SOCKET)}`,
      `ticket:join ${id(99)}`,
    ]);
    expect(socket().serverRooms.has(id(99))).toBe(true);
    expect(socket().serverRooms.size).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
  });
});

describe('useTyping', () => {
  function mount(scope: 'public' | 'internal' = 'public') {
    const hook = renderHook(({ id }) => useTyping(id, { scope }), {
      wrapper,
      initialProps: { id: TICKET as string | null },
    });
    act(() => socket().accept());
    return hook;
  }
  const typing = () => socket().eventsNamed('message:typing');

  it('throttles "typing" and stops after 4 s without input', () => {
    const { result } = mount('internal');
    act(() => result.current.notifyTyping());
    act(() => result.current.notifyTyping());
    expect(typing()).toEqual([{ ticketId: TICKET, isTyping: true, scope: 'internal' }]);

    act(() => vi.advanceTimersByTime(TYPING_THROTTLE_MS));
    act(() => result.current.notifyTyping());
    expect(typing()).toHaveLength(2);

    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS));
    expect(typing().at(-1)).toEqual({ ticketId: TICKET, isTyping: false, scope: 'internal' });
  });

  it('stops typing on send and when leaving the ticket', () => {
    const { result, rerender } = mount();
    act(() => result.current.notifyTyping());
    act(() => result.current.stopTyping());
    expect(typing().at(-1)).toMatchObject({ isTyping: false });
    act(() => result.current.notifyTyping());
    rerender({ id: null });
    expect(typing().at(-1)).toEqual({ ticketId: TICKET, isTyping: false, scope: 'public' });
  });

  it('lists other people typing in this ticket, forgets them after the TTL, ignores me', () => {
    const { result } = mount();
    const other = { id: '00000000-0000-4000-8000-000000000501', name: 'Aisha' };
    act(() => {
      socket().receive('message:typing', {
        ticketId: TICKET,
        user: other,
        isTyping: true,
        scope: 'public',
      });
      socket().receive('message:typing', {
        ticketId: TICKET,
        user: ME,
        isTyping: true,
        scope: 'public',
      });
      socket().receive('message:typing', {
        ticketId: '00000000-0000-4000-8000-000000000999',
        user: { id: 'x', name: 'Elsewhere' },
        isTyping: true,
        scope: 'public',
      });
    });
    expect(result.current.typingUsers).toEqual([{ ...other, scope: 'public' }]);

    act(() => {
      socket().receive('message:typing', {
        ticketId: TICKET,
        user: other,
        isTyping: false,
        scope: 'public',
      });
    });
    expect(result.current.typingUsers).toEqual([]);

    act(() => {
      socket().receive('message:typing', {
        ticketId: TICKET,
        user: other,
        isTyping: true,
        scope: 'internal',
      });
    });
    expect(result.current.typingUsers).toEqual([{ ...other, scope: 'internal' }]);
    act(() => vi.advanceTimersByTime(TYPING_REMOTE_TTL_MS));
    expect(result.current.typingUsers).toEqual([]);
  });
});
