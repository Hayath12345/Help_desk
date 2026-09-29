import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_LIMITS,
  listNotificationsQuerySchema,
  markNotificationsReadSchema,
  notificationDtoSchema,
  notificationNewPayloadSchema,
} from './notifications.ts';

const ID = '3f1c2a8e-5b7d-4c1e-9a2b-6d4e8f0a1b2c';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const dto = {
  id: ID,
  type: 'SLA_AT_RISK',
  ticketId: OTHER,
  ticketNumber: 4817,
  data: {
    subject: 'Door',
    priority: 'P1',
    target: 'FIRST_REPLY',
    dueAt: '2026-10-04T08:15:00.000Z',
  },
  readAt: null,
  createdAt: '2026-10-04T08:11:15.000Z',
};

describe('notification schemas', () => {
  it('list query: unreadOnly is a real boolean ("false" stays false), limit bounded', () => {
    expect(listNotificationsQuerySchema.parse({})).toEqual({
      unreadOnly: false,
      limit: NOTIFICATION_LIMITS.pageDefault,
    });
    expect(listNotificationsQuerySchema.parse({ unreadOnly: 'false' }).unreadOnly).toBe(false);
    expect(listNotificationsQuerySchema.parse({ unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(listNotificationsQuerySchema.safeParse({ unreadOnly: 'maybe' }).success).toBe(false);
    expect(listNotificationsQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(listNotificationsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(listNotificationsQuerySchema.safeParse({ cursor: 'x'.repeat(201) }).success).toBe(false);
  });

  it('mark read: either some ids or all, never both, never empty', () => {
    expect(markNotificationsReadSchema.parse({ ids: [ID] })).toEqual({ ids: [ID] });
    expect(markNotificationsReadSchema.parse({ all: true })).toEqual({ all: true });
    // Mark all up to the newest one shown (a watermark).
    const upTo = '2026-09-29T10:00:00.000Z';
    expect(markNotificationsReadSchema.parse({ all: true, upTo })).toEqual({ all: true, upTo });
    for (const bad of [
      {},
      { ids: [] },
      { all: false },
      { ids: [ID], all: true },
      { all: true, upTo: 'soon' },
      { ids: [ID], upTo: '2026-09-29T10:00:00.000Z' },
      { ids: ['nope'] },
      { ids: Array.from({ length: NOTIFICATION_LIMITS.markReadMax + 1 }, () => ID) },
    ]) {
      expect(markNotificationsReadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('DTO: typed data fields, unknown data keys kept, unknown types refused', () => {
    const parsed = notificationDtoSchema.parse({ ...dto, data: { ...dto.data, extra: 1 } });
    expect(parsed.data).toMatchObject({ target: 'FIRST_REPLY', extra: 1 });
    expect(notificationDtoSchema.safeParse({ ...dto, type: 'SOMETHING' }).success).toBe(false);
    expect(
      notificationDtoSchema.safeParse({ ...dto, data: { ...dto.data, target: 'LUNCH' } }).success,
    ).toBe(false);
    expect(
      notificationDtoSchema.parse({ ...dto, ticketId: null, ticketNumber: null }),
    ).toMatchObject({ ticketId: null, ticketNumber: null });
  });

  it('notification:new payload carries the unread count', () => {
    expect(notificationNewPayloadSchema.parse({ notification: dto, unreadCount: 3 })).toMatchObject(
      {
        unreadCount: 3,
      },
    );
    expect(notificationNewPayloadSchema.safeParse({ notification: dto }).success).toBe(false);
  });
});
