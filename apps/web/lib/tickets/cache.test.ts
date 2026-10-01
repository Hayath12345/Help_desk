import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  applyTicketDetail,
  applyTicketSummary,
  findCachedTicket,
  lastServerMessageId,
  localMessages,
  mergeServerMessages,
  mergeThreadMessages,
  patchTicketEverywhere,
  queryHoldsTicket,
  selectTicketPages,
  setLocalMessageStatus,
  sortThread,
  toSummary,
  updateTicketEverywhere,
  upsertThreadMessage,
} from './cache';
import { ticketKeys } from './keys';
import { fixtureId, makeDetail, makeMessage, makeSummary } from './test-fixtures';
import type { ThreadMessage, TicketPages } from './types';

const pending = (n: number, body = 'pending'): ThreadMessage => ({
  ...makeMessage({
    id: fixtureId(n),
    clientTempId: fixtureId(n),
    body,
    createdAt: '2026-09-23T12:10:00.000Z',
  }),
  local: { status: 'pending', input: { type: 'PUBLIC', body } },
});

function pages(...lists: ReturnType<typeof makeSummary>[][]): TicketPages {
  return {
    pages: lists.map((items, i) => ({ items, nextCursor: i < lists.length - 1 ? `c${i}` : null })),
    pageParams: lists.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
  };
}

describe('thread messages', () => {
  it('orders server messages by createdAt and keeps optimistic ones last', () => {
    const late = makeMessage({ id: fixtureId(2), createdAt: '2026-09-23T12:05:00.000Z' });
    const early = makeMessage({ id: fixtureId(1), createdAt: '2026-09-23T12:01:00.000Z' });
    const local = pending(3);
    const sorted = sortThread([local, late, early]);
    expect(sorted.map((m) => m.id)).toEqual([early.id, late.id, local.id]);
  });

  it('replaces the optimistic message with the server copy (same clientTempId)', () => {
    const local = pending(10, 'Hello');
    const server = makeMessage({
      id: fixtureId(99),
      clientTempId: fixtureId(10),
      body: 'Hello',
      createdAt: '2026-09-23T12:11:00.000Z',
    });
    const list = upsertThreadMessage([makeMessage(), local], server);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual(server);
    expect(list.some((m) => m.local)).toBe(false);
  });

  it('deduplicates a realtime copy of a message already in the list (by id)', () => {
    const server = makeMessage({ id: fixtureId(5), clientTempId: fixtureId(6) });
    const once = upsertThreadMessage([], server);
    const twice = upsertThreadMessage(once, { ...server });
    expect(twice).toHaveLength(1);
  });

  it('never downgrades a stored message back to an optimistic one', () => {
    const server = makeMessage({ id: fixtureId(7), clientTempId: fixtureId(8) });
    const late = { ...pending(8), clientTempId: fixtureId(8) };
    const list = upsertThreadMessage([server], late);
    expect(list).toEqual([server]);
  });

  it('merges a batch, tracks the last stored id and keeps local messages', () => {
    const a = makeMessage({ id: fixtureId(1), createdAt: '2026-09-23T12:01:00.000Z' });
    const b = makeMessage({ id: fixtureId(2), createdAt: '2026-09-23T12:02:00.000Z' });
    const local = pending(3);
    const merged = mergeServerMessages([local, a], [b, a]);
    expect(merged.map((m) => m.id)).toEqual([a.id, b.id, local.id]);
    expect(lastServerMessageId(merged)).toBe(b.id);
    expect(lastServerMessageId([local])).toBeNull();
    expect(localMessages(merged)).toEqual([local]);
  });

  it('merges two versions of a thread in either order without losing a message', () => {
    const a = makeMessage({ id: fixtureId(1), createdAt: '2026-09-23T12:01:00.000Z' });
    const b = makeMessage({ id: fixtureId(2), createdAt: '2026-09-23T12:02:00.000Z' });
    const c = makeMessage({ id: fixtureId(3), createdAt: '2026-09-23T12:03:00.000Z' });
    const local = pending(4);
    const cached = [a, c, local]; // c arrived by realtime after the snapshot was read
    const snapshot = [a, b];
    const expected = [a.id, b.id, c.id, local.id];
    expect(mergeThreadMessages(cached, snapshot).map((m) => m.id)).toEqual(expected);
    expect(mergeThreadMessages(snapshot, cached).map((m) => m.id)).toEqual(expected);
    // The stored copy of a sent message replaces its optimistic bubble, in either order.
    const stored = makeMessage({ id: fixtureId(5), clientTempId: fixtureId(4) });
    expect(mergeThreadMessages([local], [stored])).toEqual([stored]);
    expect(mergeThreadMessages([stored], [local])).toEqual([stored]);
  });

  it('marks an optimistic message failed and pending again', () => {
    const local = pending(4);
    const failed = setLocalMessageStatus([local], fixtureId(4), 'failed');
    expect(failed[0]?.local?.status).toBe('failed');
    expect(setLocalMessageStatus(failed, fixtureId(4), 'pending')[0]?.local?.status).toBe(
      'pending',
    );
  });
});

describe('ticket caches', () => {
  function seeded() {
    const qc = new QueryClient();
    const detail = makeDetail();
    qc.setQueryData(ticketKeys.detail('LG-4771'), detail);
    qc.setQueryData(ticketKeys.detail(detail.id), detail);
    const other = makeSummary({ id: fixtureId(902), number: 4772, ref: 'LG-4772' });
    qc.setQueryData(ticketKeys.list({ view: 'open' }), pages([makeSummary(), other]));
    qc.setQueryData(ticketKeys.list({ view: 'mine' }), pages([other], [makeSummary()]));
    return { qc, detail, other };
  }

  it('toSummary strips detail-only fields', () => {
    const summary = toSummary(makeDetail());
    expect(summary).not.toHaveProperty('description');
    expect(summary).not.toHaveProperty('requesterCard');
    expect(summary).not.toHaveProperty('p1Chain');
    expect(summary).toEqual(makeSummary());
  });

  it('applyTicketSummary updates every copy and reports an older detail', () => {
    const { qc, detail } = seeded();
    const newer = makeSummary({ status: 'PENDING', updatedAt: '2026-09-23T13:00:00.000Z' });
    expect(applyTicketSummary(qc, newer)).toBe(true);
    expect(qc.getQueryData<typeof detail>(ticketKeys.detail('LG-4771'))?.status).toBe('PENDING');
    // Detail-only fields survive the merge.
    expect(qc.getQueryData<typeof detail>(ticketKeys.detail(detail.id))?.description).toBe(
      detail.description,
    );
    for (const filters of [{ view: 'open' as const }, { view: 'mine' as const }]) {
      const data = qc.getQueryData<TicketPages>(ticketKeys.list(filters));
      const row = data?.pages.flatMap((p) => p.items).find((t) => t.id === detail.id);
      expect(row?.status).toBe('PENDING');
    }
  });

  it('ignores out-of-order (older) summaries', () => {
    const { qc } = seeded();
    const older = makeSummary({ status: 'NEW', updatedAt: '2026-09-22T00:00:00.000Z' });
    expect(applyTicketSummary(qc, older)).toBe(false);
    expect(findCachedTicket(qc, older.id)?.status).toBe('OPEN');
    // Even when it would move the P1 fields: an older push never triggers a reload.
    const olderStep = makeSummary({ p1EscalationStep: 2, updatedAt: '2026-09-22T00:00:00.000Z' });
    expect(applyTicketSummary(qc, olderStep)).toBe(false);
  });

  // Phase 5 F15: the detail's `p1NextStep` is computed by the server from these summary fields; a
  // push that changes one of them must reload the detail even with the same `updatedAt`.
  const P1_CHANGES: [string, Partial<ReturnType<typeof makeSummary>>][] = [
    ['a step fired', { p1EscalationStep: 1 }],
    ['acknowledged', { p1AckedAt: '2026-09-23T12:06:00.000Z' }],
    ['downgraded', { priority: 'P2' }],
    ['a new P1 period', { p1Since: '2026-09-23T12:03:00.000Z' }],
    ['solved', { status: 'SOLVED' }],
  ];
  for (const [what, change] of P1_CHANGES) {
    it(`asks for the detail again when a push changes the next P1 step's inputs: ${what}`, () => {
      const { qc, detail } = seeded();
      // Same updatedAt as the cached detail: only the P1 fields tell it apart.
      expect(applyTicketSummary(qc, makeSummary({ ...change, updatedAt: detail.updatedAt }))).toBe(
        true,
      );
      // The merge still happens (the summary fields are the server's).
      const [key, value] = Object.entries(change)[0]!;
      expect((findCachedTicket(qc, detail.id) as Record<string, unknown>)[key]).toEqual(value);
    });
  }

  it('does not ask for the detail again for a same-time push that leaves the P1 inputs alone', () => {
    const { qc, detail } = seeded();
    const same = makeSummary({ subject: 'Renamed', tags: ['vpn'], updatedAt: detail.updatedAt });
    expect(applyTicketSummary(qc, same)).toBe(false);
    expect(findCachedTicket(qc, detail.id)?.subject).toBe('Renamed');
  });

  it('list rows alone never ask for a detail reload', () => {
    const qc = new QueryClient();
    qc.setQueryData(ticketKeys.list({ view: 'open' }), pages([makeSummary()]));
    expect(applyTicketSummary(qc, makeSummary({ p1EscalationStep: 2 }))).toBe(false);
    expect(
      applyTicketSummary(qc, makeSummary({ status: 'PENDING', updatedAt: '2026-09-23T13:00:00Z' })),
    ).toBe(false);
  });

  it('applyTicketDetail replaces the detail and the list rows', () => {
    const { qc, detail } = seeded();
    const next = makeDetail({ priority: 'P2', updatedAt: '2026-09-23T14:00:00.000Z' });
    applyTicketDetail(qc, next);
    expect(qc.getQueryData(ticketKeys.detail(detail.id))).toEqual(next);
    const rows = qc
      .getQueryData<TicketPages>(ticketKeys.list({ view: 'open' }))
      ?.pages.flatMap((p) => p.items);
    expect(rows?.find((t) => t.id === detail.id)).toEqual(toSummary(next));
  });

  it('updateTicketEverywhere leaves other tickets (and untouched pages) as they were', () => {
    const { qc, other } = seeded();
    const before = qc.getQueryData<TicketPages>(ticketKeys.list({ view: 'mine' }));
    updateTicketEverywhere(qc, other.id, (t) => ({ ...t, priority: 'P4' }));
    const after = qc.getQueryData<TicketPages>(ticketKeys.list({ view: 'mine' }));
    expect(after?.pages[0]?.items[0]?.priority).toBe('P4');
    expect(after?.pages[1]).toBe(before?.pages[1]);
  });

  it('patchTicketEverywhere patches every copy and its rollback restores them', () => {
    const { qc, detail } = seeded();
    const rollback = patchTicketEverywhere(qc, detail.id, (t) => ({ ...t, status: 'SOLVED' }));
    const copies = () => [
      qc.getQueryData<typeof detail>(ticketKeys.detail('LG-4771'))?.status,
      qc.getQueryData<typeof detail>(ticketKeys.detail(detail.id))?.status,
      ...[{ view: 'open' as const }, { view: 'mine' as const }].map(
        (filters) =>
          qc
            .getQueryData<TicketPages>(ticketKeys.list(filters))
            ?.pages.flatMap((p) => p.items)
            .find((t) => t.id === detail.id)?.status,
      ),
    ];
    expect(copies()).toEqual(['SOLVED', 'SOLVED', 'SOLVED', 'SOLVED']);
    rollback();
    expect(copies()).toEqual(['OPEN', 'OPEN', 'OPEN', 'OPEN']);
  });

  it('a rollback never overwrites newer data that arrived meanwhile (F4)', () => {
    const { qc, detail, other } = seeded();
    const read = () => qc.getQueryData<typeof detail>(ticketKeys.detail('LG-4771'))!;
    const rollback = patchTicketEverywhere(qc, detail.id, (t) => ({
      ...t,
      priority: 'P3',
      assignee: { id: fixtureId(801), name: 'Priya Shah' },
      ...('requesterCard' in t ? { assetId: 'CAM-099' } : {}),
    }));
    // A realtime push (the client solved it, a new preview) lands while the PATCH is in flight.
    applyTicketSummary(
      qc,
      makeSummary({
        status: 'SOLVED',
        priority: 'P3',
        assignee: { id: fixtureId(801), name: 'Priya Shah' },
        preview: 'Solved by the client',
        updatedAt: '2026-09-23T13:00:00.000Z',
      }),
    );
    // Another ticket changes too: the rollback must not touch it.
    updateTicketEverywhere(qc, other.id, (t) => ({ ...t, status: 'PENDING' }));
    rollback();
    // The pushed summary is the server's truth now; only the detail-only field this patch
    // wrote (the push doesn't carry it) goes back.
    expect(read()).toMatchObject({
      status: 'SOLVED',
      priority: 'P3',
      assignee: { id: fixtureId(801), name: 'Priya Shah' },
      preview: 'Solved by the client',
      updatedAt: '2026-09-23T13:00:00.000Z',
      assetId: detail.assetId,
    });
    expect(findCachedTicket(qc, other.id)?.status).toBe('PENDING');
  });

  it('a rollback only undoes fields that still hold the value it wrote', () => {
    const { qc, detail } = seeded();
    const read = () => qc.getQueryData<typeof detail>(ticketKeys.detail('LG-4771'))!;
    const rollback = patchTicketEverywhere(qc, detail.id, (t) => ({ ...t, priority: 'P3' }));
    // A second optimistic change (same updatedAt) edits another field and this one.
    updateTicketEverywhere(qc, detail.id, (t) => ({
      ...t,
      status: 'PENDING',
      impact: 'DEPARTMENT',
    }));
    patchTicketEverywhere(qc, detail.id, (t) => ({ ...t, priority: 'P2' }));
    rollback();
    expect(read()).toMatchObject({ status: 'PENDING', impact: 'DEPARTMENT', priority: 'P2' });
  });

  it('queryHoldsTicket matches only queries holding a copy of the ticket', () => {
    const { qc, detail, other } = seeded();
    qc.setQueryData(ticketKeys.list({ view: 'solved' }), pages([other]));
    const holding = qc
      .getQueryCache()
      .findAll({ queryKey: ticketKeys.all })
      .filter((query) => queryHoldsTicket(query, detail.id))
      .map((query) => JSON.stringify(query.queryKey));
    expect(holding.sort()).toEqual(
      [
        ticketKeys.detail('LG-4771'),
        ticketKeys.detail(detail.id),
        ticketKeys.list({ view: 'open' }),
        ticketKeys.list({ view: 'mine' }),
      ]
        .map((k) => JSON.stringify(k))
        .sort(),
    );
  });

  it('selectTicketPages flattens every loaded page in order', () => {
    const a = makeSummary();
    const b = makeSummary({ id: fixtureId(903) });
    expect(selectTicketPages(pages([a], [b])).items.map((t) => t.id)).toEqual([a.id, b.id]);
  });
});
