import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STAFF_VIEWS, TICKET_LIST_SORTS } from '../tickets.ts';
import {
  AGENT_QUEUE_CAPACITY,
  BULK_TICKETS_MAX,
  QUEUE_TAB_SORTS,
  QUEUE_TAB_VIEWS,
  QUEUE_TABS,
  bulkTicketOutcomeSchema,
  bulkTicketsSchema,
  queueCountsQuerySchema,
} from './queue.ts';
import { customersQuerySchema } from './customers.ts';
import { DEFAULT_REPORT_PERIOD, REPORT_PERIOD_DAYS, reportsSummaryQuerySchema } from './reports.ts';
import { listTicketsQuerySchema, ticketEventDtoSchema } from './tickets.ts';

// Phase 5 contracts: Team queue (F3–F6), Reports (F11), Customers (F8), GET /tickets filters (F4,
// F9) and the activity timeline DTO (F14).

describe('Team queue contract', () => {
  it('capacity 6; each tab maps to a GET /tickets view and sort', () => {
    expect(AGENT_QUEUE_CAPACITY).toBe(6);
    expect(QUEUE_TABS).toEqual(['open', 'unassigned', 'breaching', 'solved']);
    expect(QUEUE_TAB_VIEWS).toEqual({
      open: 'open',
      unassigned: 'unassigned',
      breaching: 'risk',
      solved: 'solved',
    });
    for (const tab of QUEUE_TABS) {
      expect(STAFF_VIEWS).toContain(QUEUE_TAB_VIEWS[tab]);
      expect(TICKET_LIST_SORTS).toContain(QUEUE_TAB_SORTS[tab]);
    }
    expect(QUEUE_TAB_SORTS.solved).toBe('recent');
  });

  it('bulk: 1–50 unique ids and a known action', () => {
    const id = randomUUID();
    expect(bulkTicketsSchema.parse({ ids: [id], action: 'assignToMe' })).toEqual({
      ids: [id],
      action: 'assignToMe',
    });
    const many = Array.from({ length: BULK_TICKETS_MAX }, () => randomUUID());
    expect(bulkTicketsSchema.safeParse({ ids: many, action: 'solve' }).success).toBe(true);
    for (const body of [
      { ids: [], action: 'solve' },
      { ids: [...many, randomUUID()], action: 'solve' },
      { ids: [id, id], action: 'solve' },
      { ids: [id, id.toUpperCase()], action: 'solve' },
      { ids: [id], action: 'close' },
      { ids: ['LG-1'], action: 'solve' },
    ]) {
      expect(bulkTicketsSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('bulk outcomes: ok with `changed`, or a failure reason', () => {
    const id = randomUUID();
    expect(bulkTicketOutcomeSchema.parse({ id, ok: true, changed: false })).toEqual({
      id,
      ok: true,
      changed: false,
    });
    expect(
      bulkTicketOutcomeSchema.safeParse({
        id,
        ok: false,
        error: { reason: 'not_found', message: 'Ticket not found' },
      }).success,
    ).toBe(true);
    expect(
      bulkTicketOutcomeSchema.safeParse({ id, ok: false, error: { reason: 'nope', message: '' } })
        .success,
    ).toBe(false);
  });

  it('GET /tickets and queue-counts filters: `assigneeId` is a uuid or "none"', () => {
    const id = randomUUID();
    expect(
      listTicketsQuerySchema.parse({ assigneeId: 'none', priority: 'P1', sort: 'priority' }),
    ).toMatchObject({ assigneeId: 'none', priority: 'P1', sort: 'priority', limit: 50 });
    expect(queueCountsQuerySchema.parse({ assigneeId: id, orgId: id, requesterId: id })).toEqual({
      assigneeId: id,
      orgId: id,
      requesterId: id,
    });
    for (const query of [{ assigneeId: 'me' }, { priority: 'P5' }, { orgId: 'x' }, { sort: 'x' }]) {
      expect(listTicketsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
    // Search is cleaned like everywhere else.
    expect(queueCountsQuerySchema.parse({ search: ' \u0000abc ' }).search).toBe('abc');
  });
});

describe('Reports and Customers queries', () => {
  it('period: 7d, 30d (default) or 90d', () => {
    expect(reportsSummaryQuerySchema.parse({})).toEqual({ period: DEFAULT_REPORT_PERIOD });
    expect(DEFAULT_REPORT_PERIOD).toBe('30d');
    expect(REPORT_PERIOD_DAYS).toEqual({ '7d': 7, '30d': 30, '90d': 90 });
    expect(reportsSummaryQuerySchema.safeParse({ period: '1y' }).success).toBe(false);
  });

  it('customers: search cleaned, limit 1–100 (default 50)', () => {
    expect(customersQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(customersQuerySchema.parse({ search: '\u0007 Ann ', limit: '5' })).toEqual({
      search: 'Ann',
      limit: 5,
    });
    expect(customersQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('activity timeline DTO', () => {
  it('values are tagged by kind; unknown kinds are refused', () => {
    const event = {
      id: randomUUID(),
      type: 'TEAM_CHANGED',
      actor: null,
      from: {
        kind: 'team',
        id: randomUUID(),
        key: 'soc',
        nameEn: 'SOC',
        nameAr: 'SOC',
        isActive: false,
      },
      to: { kind: 'removed', entity: 'team', id: randomUUID() },
      meta: {},
      createdAt: '2026-09-30T10:00:00.000Z',
    };
    expect(ticketEventDtoSchema.parse(event)).toEqual(event);
    expect(
      ticketEventDtoSchema.safeParse({ ...event, from: { kind: 'secret', value: 'x' } }).success,
    ).toBe(false);
  });
});
