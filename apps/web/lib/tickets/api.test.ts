import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAllMessages,
  fetchFormContext,
  fetchTicket,
  fetchTicketFormConfig,
  fetchTickets,
  postMessage,
  updateTicket,
  withQuery,
} from './api';
import {
  FORM_CONFIG,
  FORM_CONTEXT,
  IDS,
  fixtureId,
  makeDetail,
  makeMessage,
  makeSummary,
} from './test-fixtures';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('@/lib/api/browser', () => ({ apiClient: api }));

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.patch.mockReset();
});

describe('withQuery', () => {
  it('skips empty values and encodes the rest', () => {
    expect(withQuery('/tickets', { view: 'open', search: 'a b&c', cursor: null, x: '' })).toBe(
      '/tickets?view=open&search=a+b%26c',
    );
    expect(withQuery('/tickets', {})).toBe('/tickets');
  });
});

describe('fetchers', () => {
  it('parses responses with the contract schemas', async () => {
    api.get.mockResolvedValueOnce(FORM_CONFIG);
    await expect(fetchTicketFormConfig()).resolves.toEqual(FORM_CONFIG);
    expect(api.get).toHaveBeenCalledWith('/config/ticket-form', { signal: undefined });

    api.get.mockResolvedValueOnce(FORM_CONTEXT);
    await fetchFormContext(IDS.requester);
    expect(api.get).toHaveBeenLastCalledWith(
      `/tickets/form-context?requesterId=${IDS.requester}`,
      expect.anything(),
    );
  });

  it('fails loudly (outside production) when the API drifts from the contract', async () => {
    api.get.mockResolvedValueOnce({ ...FORM_CONFIG, socPhone: 42 });
    await expect(fetchTicketFormConfig()).rejects.toThrow();
  });

  it('unwraps ticket envelopes and encodes refs', async () => {
    api.get.mockResolvedValueOnce({ ticket: makeDetail() });
    await expect(fetchTicket(' LG-4771 ')).resolves.toMatchObject({ ref: 'LG-4771' });
    expect(api.get).toHaveBeenCalledWith('/tickets/LG-4771', { signal: undefined });

    api.patch.mockResolvedValueOnce({ ticket: makeDetail({ status: 'SOLVED' }) });
    await expect(updateTicket(IDS.ticket, { status: 'SOLVED' })).resolves.toMatchObject({
      status: 'SOLVED',
    });
    expect(api.patch).toHaveBeenCalledWith(`/tickets/${IDS.ticket}`, { status: 'SOLVED' });
  });

  it('passes list filters and the cursor', async () => {
    api.get.mockResolvedValueOnce({ items: [makeSummary()], nextCursor: 'n1' });
    const list = await fetchTickets({ view: 'open', sort: 'sla' }, 'c0');
    expect(list.nextCursor).toBe('n1');
    expect(api.get).toHaveBeenCalledWith('/tickets?view=open&sort=sla&cursor=c0', {
      signal: undefined,
    });
  });

  it('follows message pages until a short page', async () => {
    const page = (start: number, n: number) => ({
      items: Array.from({ length: n }, (_, i) => makeMessage({ id: fixtureId(start + i) })),
    });
    api.get.mockResolvedValueOnce(page(1000, 200)).mockResolvedValueOnce(page(2000, 3));
    const all = await fetchAllMessages(IDS.ticket, { after: fixtureId(5) });
    expect(all).toHaveLength(203);
    expect(api.get.mock.calls[0]?.[0]).toBe(
      `/tickets/${IDS.ticket}/messages?after=${fixtureId(5)}&limit=200`,
    );
    expect(api.get.mock.calls[1]?.[0]).toBe(
      `/tickets/${IDS.ticket}/messages?after=${fixtureId(1199)}&limit=200`,
    );
  });

  it('posts messages to the ticket', async () => {
    api.post.mockResolvedValueOnce({ message: makeMessage(), ticket: makeSummary() });
    await postMessage(IDS.ticket, {
      type: 'PUBLIC',
      body: 'Hi',
      clientTempId: fixtureId(3),
      attachmentIds: [],
      andSolve: false,
    });
    expect(api.post).toHaveBeenCalledWith(`/tickets/${IDS.ticket}/messages`, {
      type: 'PUBLIC',
      body: 'Hi',
      clientTempId: fixtureId(3),
      attachmentIds: [],
      andSolve: false,
    });
  });
});
