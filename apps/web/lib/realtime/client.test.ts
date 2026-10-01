import { MAX_TICKET_ROOMS_PER_SOCKET } from '@loons/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api/errors';
import { RealtimeClient } from './client';
import { fakeSocketFactory, type FakeSocket } from './fake-socket';

const TICKET = '00000000-0000-4000-8000-000000000901';
const OTHER = '00000000-0000-4000-8000-000000000902';

function setup(
  getToken = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) =>
    forceRefresh ? 'fresh-token' : 'cached-token',
  ),
) {
  const { factory, sockets } = fakeSocketFactory();
  const client = new RealtimeClient({
    url: 'http://api.test',
    getToken,
    createSocket: factory,
    backoffMs: (attempt) => 100 * (attempt + 1),
    idleCloseMs: 50,
    roomRetryMs: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
  });
  const socket = () => sockets[sockets.length - 1] as FakeSocket;
  return { client, sockets, socket, getToken };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('RealtimeClient', () => {
  it('connects to /socket.io with the API token and reports its status', async () => {
    const { client, socket } = setup();
    const statuses: string[] = [];
    client.subscribeStatus(() => statuses.push(client.getStatus()));
    client.start();
    expect(socket().options.path).toBe('/socket.io');
    expect(socket().options.autoConnect).toBe(false);
    // Sticky sessions behind a load balancer need the cookie on cross-origin polling requests.
    expect(socket().options.withCredentials).toBe(true);
    await vi.waitFor(() => expect(socket().authTokens).toEqual(['cached-token']));
    socket().accept();
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('joins ticket rooms once (ref-counted) and re-joins them after every connect', async () => {
    const { client, socket } = setup();
    const release1 = client.joinTicket(TICKET); // before the connection exists
    client.start();
    socket().accept();
    expect(socket().eventsNamed('ticket:join')).toEqual([{ ticketId: TICKET }]);

    const release2 = client.joinTicket(TICKET);
    client.joinTicket(OTHER);
    expect(socket().eventsNamed('ticket:join')).toEqual([
      { ticketId: TICKET },
      { ticketId: OTHER },
    ]);
    release1();
    release1(); // idempotent
    await flush();
    expect(socket().eventsNamed('ticket:leave')).toEqual([]);
    release2();
    await flush();
    expect(socket().eventsNamed('ticket:leave')).toEqual([{ ticketId: TICKET }]);
    expect(client.joinedTickets()).toEqual([OTHER]);
    expect([...socket().serverRooms]).toEqual([OTHER]);

    // Transport drop → socket.io reconnects by itself → rooms are joined again + catch-up runs.
    const onReconnect = vi.fn();
    client.onReconnect(onReconnect);
    socket().transportClose();
    expect(client.getStatus()).toBe('reconnecting');
    socket().accept();
    expect(socket().eventsNamed('ticket:join').at(-1)).toEqual({ ticketId: OTHER });
    expect([...socket().serverRooms]).toEqual([OTHER]);
    await flush();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  describe('room requests are serialised per ticket (F5)', () => {
    function connected() {
      const ctx = setup();
      ctx.client.start();
      ctx.socket().accept();
      ctx.socket().holdAcks = true;
      return ctx;
    }
    const sent = (s: FakeSocket) =>
      s.emitted
        .filter((e) => e.event.startsWith('ticket:'))
        .map((e) => `${e.event.slice(7)} ${(e.payload as { ticketId: string }).ticketId}`);

    it('join → leave: the leave waits for the join ack, so the socket ends outside the room', async () => {
      const { client, socket } = connected();
      const release = client.joinTicket(TICKET);
      release();
      await flush();
      expect(sent(socket())).toEqual([`join ${TICKET}`]); // leave not sent while the join is pending
      socket().deliverAcks();
      await flush();
      expect(sent(socket())).toEqual([`join ${TICKET}`, `leave ${TICKET}`]);
      socket().deliverAcks();
      await flush();
      expect(socket().serverRooms.has(TICKET)).toBe(false);
      expect(client.joinedTickets()).toEqual([]);
    });

    it('leave → join: the join waits for the leave ack, so the socket ends inside the room', async () => {
      const { client, socket } = connected();
      const joined = vi.fn();
      client.onRoomJoined(joined);
      const release = client.joinTicket(TICKET);
      socket().deliverAcks();
      expect(joined).toHaveBeenCalledWith(TICKET);
      release();
      await flush(); // the leave goes out
      client.joinTicket(TICKET); // back before the leave was answered
      expect(sent(socket())).toEqual([`join ${TICKET}`, `leave ${TICKET}`]);
      socket().deliverAcks();
      await flush();
      expect(sent(socket())).toEqual([`join ${TICKET}`, `leave ${TICKET}`, `join ${TICKET}`]);
      socket().deliverAcks();
      await flush();
      expect(socket().serverRooms.has(TICKET)).toBe(true);
      expect(joined).toHaveBeenCalledTimes(2);
      expect(client.joinedTickets()).toEqual([TICKET]);
    });

    it('a release followed by a re-acquire in the same tick sends nothing', async () => {
      const { client, socket } = connected();
      const release = client.joinTicket(TICKET);
      socket().deliverAcks();
      release();
      client.joinTicket(TICKET); // e.g. React StrictMode, or a list whose rows changed
      await flush();
      expect(sent(socket())).toEqual([`join ${TICKET}`]);
      expect(socket().serverRooms.has(TICKET)).toBe(true);
    });

    it('handles each ticket independently', async () => {
      const { client, socket } = connected();
      const releaseA = client.joinTicket(TICKET);
      client.joinTicket(OTHER);
      releaseA();
      await flush();
      // OTHER's join doesn't wait for TICKET's.
      expect(sent(socket())).toEqual([`join ${TICKET}`, `join ${OTHER}`]);
      socket().deliverAcks([1, 0]);
      await flush();
      socket().deliverAcks();
      await flush();
      expect([...socket().serverRooms]).toEqual([OTHER]);
    });

    it('does not retry a refused join until the room is acquired again', async () => {
      const { client, socket } = connected();
      socket().joinAck = { ok: false, error: 'NOT_FOUND' };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const joined = vi.fn();
      client.onRoomJoined(joined);
      const release = client.joinTicket(TICKET);
      socket().deliverAcks();
      await flush();
      client.joinTicket(TICKET)(); // another holder comes and goes
      await flush();
      expect(sent(socket())).toEqual([`join ${TICKET}`]);
      release();
      await flush();
      socket().joinAck = { ok: true };
      client.joinTicket(TICKET);
      socket().deliverAcks();
      expect(sent(socket())).toEqual([`join ${TICKET}`, `join ${TICKET}`]);
      expect(joined).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('re-joins after a reconnect, ignores acks of the old connection and then runs the reconnect listeners', async () => {
      const { client, socket } = connected();
      const onReconnect = vi.fn();
      const joined = vi.fn();
      client.onReconnect(onReconnect);
      client.onRoomJoined(joined);
      client.joinTicket(TICKET);
      socket().transportClose(); // the join was never answered on that connection
      socket().accept();
      expect(sent(socket())).toEqual([`join ${TICKET}`, `join ${TICKET}`]);
      await flush();
      expect(onReconnect).not.toHaveBeenCalled(); // waits for the re-join
      socket().deliverAcks([1]); // the new connection's join
      await flush();
      expect(joined).toHaveBeenCalledTimes(1);
      expect(onReconnect).toHaveBeenCalledTimes(1);
      socket().deliverAcks(); // the stale ack of the first connection changes nothing
      await flush();
      expect(joined).toHaveBeenCalledTimes(1);
      expect(sent(socket())).toHaveLength(2);
    });
  });

  describe('the per-socket rooms cap (MAX_TICKET_ROOMS_PER_SOCKET)', () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const rooms = (s: FakeSocket) =>
      s.emitted
        .filter((e) => e.event.startsWith('ticket:'))
        .map((e) => `${e.event.slice(7)} ${(e.payload as { ticketId: string }).ticketId}`);

    /** A connected tab whose server enforces the cap, holding `count` rooms (1 … count). */
    function atCap(count = MAX_TICKET_ROOMS_PER_SOCKET) {
      const ctx = setup();
      ctx.client.start();
      ctx.socket().accept();
      ctx.socket().maxRooms = MAX_TICKET_ROOMS_PER_SOCKET;
      const releases = new Map<number, () => void>();
      for (let n = 1; n <= count; n += 1) releases.set(n, ctx.client.joinTicket(id(n)));
      ctx.socket().emitted.length = 0;
      return { ...ctx, releases };
    }

    it('an effect swap at the cap sends the leave before the join, so the new room is joined', async () => {
      const { client, socket, releases } = atCap();
      expect(socket().serverRooms.size).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
      const joined = vi.fn();
      client.onRoomJoined(joined);
      // useTicketRooms' effect swap: the old effect's cleanup, then the new effect, one tick.
      releases.get(1)!();
      client.joinTicket(id(51));
      expect(rooms(socket())).toEqual([]); // nothing yet: the swap is sent as one, a tick later
      await flush();
      expect(rooms(socket())).toEqual([`leave ${id(1)}`, `join ${id(51)}`]);
      expect(socket().serverRooms.has(id(51))).toBe(true);
      expect(socket().serverRooms.has(id(1))).toBe(false);
      expect(socket().serverRooms.size).toBe(MAX_TICKET_ROOMS_PER_SOCKET);
      expect(joined).toHaveBeenCalledWith(id(51));
    });

    it('a swap that re-acquires a released room in the same tick sends nothing for it', async () => {
      const { client, socket, releases } = atCap(3);
      releases.get(1)!();
      releases.get(2)!();
      client.joinTicket(id(1)); // still a row after the list changed
      client.joinTicket(id(4));
      await flush();
      expect(rooms(socket())).toEqual([`leave ${id(2)}`, `join ${id(4)}`]);
      expect([...socket().serverRooms].sort()).toEqual([id(1), id(3), id(4)]);
    });

    it('retries a TOO_MANY_ROOMS join as soon as a leave completes', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { client, socket, releases } = atCap();
      const joined = vi.fn();
      client.onRoomJoined(joined);
      client.joinTicket(id(51)); // one room too many: refused, not final
      expect(rooms(socket())).toEqual([`join ${id(51)}`]);
      expect(socket().serverRooms.has(id(51))).toBe(false);
      await flush();
      releases.get(7)!(); // a row goes away: its leave frees a room
      await flush();
      expect(rooms(socket())).toEqual([`join ${id(51)}`, `leave ${id(7)}`, `join ${id(51)}`]);
      expect(socket().serverRooms.has(id(51))).toBe(true);
      expect(joined).toHaveBeenCalledWith(id(51));
      warn.mockRestore();
    });

    it('retries a TOO_MANY_ROOMS join after a backoff when no leave comes', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { client, socket } = atCap(1);
      socket().nextJoinAcks.push({ ok: false, error: 'TOO_MANY_ROOMS' });
      client.joinTicket(id(2));
      await vi.advanceTimersByTimeAsync(999);
      expect(rooms(socket())).toEqual([`join ${id(2)}`]);
      await vi.advanceTimersByTimeAsync(1);
      expect(rooms(socket())).toEqual([`join ${id(2)}`, `join ${id(2)}`]);
      expect(socket().serverRooms.has(id(2))).toBe(true);
      warn.mockRestore();
    });

    it('retries a RATE_LIMITED join with a growing backoff until it is joined', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { client, socket } = atCap(0);
      socket().nextJoinAcks.push(
        { ok: false, error: 'RATE_LIMITED' },
        { ok: false, error: 'RATE_LIMITED' },
      );
      const joined = vi.fn();
      client.onRoomJoined(joined);
      client.joinTicket(TICKET);
      expect(rooms(socket())).toEqual([`join ${TICKET}`]);
      await vi.advanceTimersByTimeAsync(1000); // 1 s
      expect(rooms(socket())).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1999); // then 2 s
      expect(rooms(socket())).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(rooms(socket())).toEqual([`join ${TICKET}`, `join ${TICKET}`, `join ${TICKET}`]);
      expect(joined).toHaveBeenCalledTimes(1);
      expect(socket().serverRooms.has(TICKET)).toBe(true);
      // Joined: nothing else is sent.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rooms(socket())).toHaveLength(3);
      warn.mockRestore();
    });

    it('stops retrying once the room is released', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { client, socket } = atCap(0);
      socket().joinAck = { ok: false, error: 'RATE_LIMITED' };
      const release = client.joinTicket(TICKET);
      release();
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rooms(socket())).toEqual([`join ${TICKET}`]);
      expect(client.joinedTickets()).toEqual([]);
      warn.mockRestore();
    });

    it.each(['NOT_FOUND', 'FORBIDDEN'])(
      'never retries a %s join for the same holder',
      async (error) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { client, socket, releases } = atCap(2);
        socket().joinAck = { ok: false, error };
        client.joinTicket(TICKET);
        await flush();
        releases.get(1)!(); // a leave completes: no retry either
        await flush();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(rooms(socket())).toEqual([`join ${TICKET}`, `leave ${id(1)}`]);
        warn.mockRestore();
      },
    );
  });

  it('reconnects with a fresh token after the server closes the socket (token expiry)', async () => {
    const { client, socket, getToken } = setup();
    client.start();
    await flush();
    socket().accept();
    socket().serverClose();
    expect(client.getStatus()).toBe('reconnecting');
    expect(socket().connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(socket().connectCalls).toBe(2);
    await vi.waitFor(() => expect(socket().authTokens).toEqual(['cached-token', 'fresh-token']));
    expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it('retries a refused handshake (expired / revoked token) with backoff', async () => {
    const { client, socket } = setup();
    client.start();
    socket().refuse('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(100);
    expect(socket().connectCalls).toBe(2);
    socket().refuse('UNAUTHENTICATED');
    await vi.advanceTimersByTimeAsync(150);
    expect(socket().connectCalls).toBe(2); // second delay is 200 ms
    await vi.advanceTimersByTimeAsync(50);
    expect(socket().connectCalls).toBe(3);
    socket().accept();
    expect(client.getStatus()).toBe('connected');
  });

  it('gives up for accounts that may not use realtime (FORBIDDEN)', async () => {
    const { client, socket, sockets } = setup();
    client.start();
    socket().refuse('FORBIDDEN');
    expect(client.getStatus()).toBe('forbidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket().connectCalls).toBe(1);
    client.start(); // no second connection in this tab
    expect(sockets).toHaveLength(1);
  });

  it('stops when the web session has ended (/api/token → 401)', async () => {
    const getToken = vi.fn(async () => {
      throw new ApiRequestError(401, 'UNAUTHENTICATED', 'signed out');
    });
    const { client, socket } = setup(getToken);
    client.start();
    await flush();
    expect(socket().authTokens).toEqual(['']);
    socket().refuse('UNAUTHENTICATED');
    expect(client.getStatus()).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket().connectCalls).toBe(1);
  });

  it('dispatches server events to listeners and isolates failing ones', () => {
    const { client, socket } = setup();
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.on('queue:updated', bad);
    const off = client.on('queue:updated', good);
    client.start();
    socket().receive('queue:updated', { teamId: 't', ticketId: TICKET, reason: 'message' });
    expect(good).toHaveBeenCalledWith({ teamId: 't', ticketId: TICKET, reason: 'message' });
    off();
    socket().receive('queue:updated', {});
    expect(good).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('sends typing only while connected, as volatile packets', () => {
    const { client, socket } = setup();
    client.start();
    client.sendTyping({ ticketId: TICKET, isTyping: true, scope: 'public' });
    expect(socket().emitted).toEqual([]);
    socket().accept();
    client.sendTyping({ ticketId: TICKET, isTyping: true, scope: 'internal' });
    expect(socket().emitted).toEqual([
      {
        event: 'message:typing',
        payload: { ticketId: TICKET, isTyping: true, scope: 'internal' },
        volatile: true,
      },
    ]);
  });

  it('acquire / release keeps one connection and closes it after the last holder', async () => {
    const { client, sockets, socket } = setup();
    client.acquire();
    client.acquire();
    socket().accept();
    client.release();
    client.release();
    await vi.advanceTimersByTimeAsync(20);
    client.acquire(); // re-acquired before the idle close: same socket
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(1);
    expect(client.getStatus()).toBe('connected');
    client.release();
    await vi.advanceTimersByTimeAsync(60);
    expect(client.getStatus()).toBe('stopped');
    expect(socket().connected).toBe(false);
  });
});
