import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { BusinessHours } from '@loons/db';
import {
  businessHoursDtoSchema,
  holidayListSchema,
  holidayResponseSchema,
  type BusinessHoursDto,
} from '@loons/shared';
import type { WorkerContext } from '../src/jobs/context.ts';
import { queueDeliveries } from '../src/jobs/context.ts';
import { processDelivery } from '../src/jobs/deliver.ts';
import { deliveryJobSchema } from '../src/lib/job-data.ts';
import { businessDayMinutes } from '../src/services/ticket-config.service.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import {
  apiAs,
  createTicket,
  createWorld,
  persona,
  ticketBody,
  type Persona,
  type World,
} from './ticket-world.ts';
import { fakeEmail, testWorkerContext } from './worker-helpers.ts';

// Admin — Business hours & holidays (spec §10.5; E12). Super admins only. The week is saved whole
// with every day's `expectedUpdatedAt`; holidays are archived / restored, and an existing date
// (archived included) is 409 `duplicate` with the row to restore. Every change writes its audit
// rows in the same transaction and announces `calendar`. The week and holidays are global rows of
// the shared dev database: only a CLOSED day's times are edited (the calendar ignores them) and
// holidays are added in 2099; everything is restored / deleted afterwards.

describe('admin business hours & holidays', () => {
  let ctx: TestContext;
  let w: World;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let closedDay: BusinessHours;
  let savedWeek: BusinessHours[] = [];
  const holidayIds = new Set<string>();
  let broadcast: MockInstance<(event: string, payload: unknown) => void>;

  beforeAll(async () => {
    ctx = await createTestContext();
    w = await createWorld(ctx);
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    superAdmin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    teamLead = w.leadA;
    agent = w.agentA;
    client = w.clientX;
    const closed = await ctx.prisma.businessHours.findFirst({
      where: { isOpen: false },
      orderBy: { weekday: 'asc' },
    });
    if (!closed) throw new Error('the dev database needs a closed weekday (seed: Fri / Sat)');
    closedDay = closed;
    // The whole week as it was: whatever a test (or broken code under test) wrote to these shared
    // rows is put back after each test.
    savedWeek = await ctx.prisma.businessHours.findMany();
    f.onCleanup(async () => {
      await restoreWeek();
      await ctx.prisma.adminAuditLog.deleteMany({
        where: { entityId: { in: [closedDay.id, ...holidayIds] } },
      });
      await ctx.prisma.holiday.deleteMany({ where: { id: { in: [...holidayIds] } } });
    });
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(() => broadcast.mockClear());
  afterEach(() => restoreWeek());

  /** Puts back any weekday that differs from the snapshot. */
  async function restoreWeek() {
    const now = await ctx.prisma.businessHours.findMany();
    for (const row of savedWeek) {
      const current = now.find((r) => r.id === row.id);
      if (
        current &&
        current.isOpen === row.isOpen &&
        current.open === row.open &&
        current.close === row.close
      )
        continue;
      await ctx.prisma.businessHours.update({
        where: { id: row.id },
        data: { isOpen: row.isOpen, open: row.open, close: row.close },
      });
    }
  }

  const scopes = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope);
  const week = async (): Promise<BusinessHoursDto> =>
    businessHoursDtoSchema.parse(
      (await apiAs(ctx, superAdmin).get('/admin/business-hours')).json(),
    );
  const weekBody = (
    dto: BusinessHoursDto,
    change?: (day: BusinessHoursDto['days'][number]) => object,
  ) => ({
    days: dto.days.map((d) => ({
      weekday: d.weekday,
      isOpen: d.isOpen,
      open: d.open,
      close: d.close,
      expectedUpdatedAt: d.updatedAt,
      ...(change ? change(d) : {}),
    })),
  });
  /** A date in 2099 no other test uses. */
  const futureDate = () => {
    const day = new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 360) * 86_400_000);
    return day.toISOString().slice(0, 10);
  };
  async function addHoliday(name = `Test holiday ${rand(3)}`) {
    for (;;) {
      const date = futureDate();
      const res = await apiAs(ctx, superAdmin).post('/admin/business-hours/holidays', {
        date,
        name,
        nameAr: 'عطلة',
      });
      if (res.statusCode === 409) continue; // another run's date
      expect(res.statusCode, res.body).toBe(201);
      const { item } = holidayResponseSchema.parse(res.json());
      holidayIds.add(item.id);
      return item;
    }
  }

  describe('access', () => {
    it('401 without a token; 403 for clients, agents and team leads', async () => {
      expect((await apiAs(ctx).get('/admin/business-hours')).statusCode).toBe(401);
      const dto = await week();
      for (const who of [client, agent, teamLead]) {
        const api = apiAs(ctx, who);
        expect((await api.get('/admin/business-hours')).statusCode, who.role).toBe(403);
        expect((await api.put('/admin/business-hours', weekBody(dto))).statusCode).toBe(403);
        expect((await api.get('/admin/business-hours/holidays')).statusCode).toBe(403);
        expect(
          (await api.post('/admin/business-hours/holidays', { date: futureDate(), name: 'x' }))
            .statusCode,
        ).toBe(403);
        expect(
          (
            await api.post(`/admin/business-hours/holidays/${randomUUID()}/archive`, {
              expectedUpdatedAt: new Date().toISOString(),
            })
          ).statusCode,
        ).toBe(403);
      }
    });
  });

  describe('the working week', () => {
    it('returns seven days (Sunday first), the time zone and the business-day length', async () => {
      const dto = await week();
      expect(dto.days.map((d) => d.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(dto.timeZone).toMatch(/\//);
      expect(dto.businessDayMinutes).toBe(businessDayMinutes(dto.days));
    });

    it('validates: HH:mm, open before close on open days, at least one open day, seven days', async () => {
      const api = apiAs(ctx, superAdmin);
      const dto = await week();
      const cases: Array<[object, string]> = [
        [weekBody(dto, (d) => (d.weekday === 1 ? { open: '7:30' } : {})), 'validation.timeFormat'],
        [
          weekBody(dto, (d) => (d.weekday === 1 ? { close: '24:00' } : {})),
          'validation.timeFormat',
        ],
        [
          weekBody(dto, (d) =>
            d.weekday === 1 ? { isOpen: true, open: '16:00', close: '08:00' } : {},
          ),
          'validation.openBeforeClose',
        ],
        [
          weekBody(dto, (d) =>
            d.weekday === 1 ? { isOpen: true, open: '08:00', close: '08:00' } : {},
          ),
          'validation.openBeforeClose',
        ],
        [weekBody(dto, () => ({ isOpen: false })), 'validation.oneOpenDay'],
        [{ days: weekBody(dto).days.slice(0, 6) }, ''],
        [weekBody(dto, () => ({ weekday: 1 })), 'validation.duplicateValue'],
      ];
      for (const [body, message] of cases) {
        const res = await api.put('/admin/business-hours', body);
        expect(res.statusCode, message).toBe(400);
        if (message) expect(JSON.stringify(res.json().error.details)).toContain(message);
      }
      expect(await week()).toEqual(dto);
      expect(scopes()).toEqual([]);
    });

    it('saves only the changed day, audits it and announces calendar; stale saves are 409', async () => {
      const api = apiAs(ctx, superAdmin);
      const start = await week();
      const target = closedDay.weekday;
      const nextOpen = start.days[target]!.open === '09:00' ? '09:15' : '09:00';
      const res = await api.put(
        '/admin/business-hours',
        weekBody(start, (d) => (d.weekday === target ? { open: nextOpen } : {})),
      );
      expect(res.statusCode, res.body).toBe(200);
      const saved = businessHoursDtoSchema.parse(res.json());
      expect(saved.days[target]).toMatchObject({ isOpen: false, open: nextOpen });
      // Only that day moved.
      for (const d of saved.days) {
        if (d.weekday !== target) expect(d.updatedAt).toBe(start.days[d.weekday]!.updatedAt);
      }
      expect(saved.days[target]!.updatedAt).not.toBe(start.days[target]!.updatedAt);
      const audit = await ctx.prisma.adminAuditLog.findMany({
        where: { entity: 'BusinessHours', entityId: closedDay.id, actorId: superAdmin.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'UPDATE',
        before: { open: start.days[target]!.open },
        after: { open: nextOpen },
      });
      expect(scopes()).toEqual(['calendar']);

      // A save from the week as it was before: someone else saved meanwhile.
      broadcast.mockClear();
      const stale = await api.put(
        '/admin/business-hours',
        weekBody(start, (d) => (d.weekday === 1 ? { close: '16:45' } : {})),
      );
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.details).toMatchObject({ reason: 'stale' });
      expect((await week()).days[1]).toEqual(saved.days[1]);
      expect(scopes()).toEqual([]);

      // Nothing changed: no audit row, no announcement.
      const same = await api.put('/admin/business-hours', weekBody(saved));
      expect(same.statusCode).toBe(200);
      expect(scopes()).toEqual([]);
      expect(
        await ctx.prisma.adminAuditLog.count({
          where: { entity: 'BusinessHours', actorId: superAdmin.id },
        }),
      ).toBe(1);
    });

    it('a failed audit insert rolls the week back (same transaction)', async () => {
      const start = await week();
      const target = closedDay.weekday;
      const ghost = {
        actor: {
          id: randomUUID(),
          role: 'SUPER_ADMIN' as const,
          status: 'ACTIVE' as const,
          orgId: null,
          teamIds: [],
          leadTeamIds: [],
          emailVerified: true,
        },
        requestId: `req-${rand()}`,
      };
      const body = weekBody(start, (d) => (d.weekday === target ? { close: '17:05' } : {}));
      await expect(ctx.app.services.admin.businessHours.update(ghost, body)).rejects.toThrow();
      expect(await week()).toEqual(start);
      expect(scopes()).toEqual([]);
    });
  });

  describe('holidays', () => {
    it('adds, renames, archives and restores a holiday with audit rows and the calendar scope', async () => {
      const api = apiAs(ctx, superAdmin);
      const h = await addHoliday('Founders day');
      expect(h).toMatchObject({ name: 'Founders day', nameAr: 'عطلة', isActive: true });
      expect(scopes()).toEqual(['calendar']);

      const renamed = await api.patch(`/admin/business-hours/holidays/${h.id}`, {
        expectedUpdatedAt: h.updatedAt,
        name: 'Founders’ day',
        nameAr: '',
      });
      expect(renamed.statusCode).toBe(200);
      const r = holidayResponseSchema.parse(renamed.json()).item;
      expect(r).toMatchObject({ name: 'Founders’ day', nameAr: null, date: h.date });

      const archived = await api.post(`/admin/business-hours/holidays/${h.id}/archive`, {
        expectedUpdatedAt: r.updatedAt,
      });
      expect(archived.statusCode).toBe(200);
      const a = holidayResponseSchema.parse(archived.json()).item;
      expect(a.isActive).toBe(false);
      // Archived holidays are out of the SLA calendar.
      const calendar = await ctx.app.services.ticketConfig.getCalendar();
      expect(calendar.holidays).not.toContain(h.date);

      const restored = await api.post(`/admin/business-hours/holidays/${h.id}/restore`, {
        expectedUpdatedAt: a.updatedAt,
      });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().item.isActive).toBe(true);
      expect((await ctx.app.services.ticketConfig.getCalendar()).holidays).toContain(h.date);

      const audit = await ctx.prisma.adminAuditLog.findMany({
        where: { entity: 'Holiday', entityId: h.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE']);
      expect(audit[1]).toMatchObject({
        before: { name: 'Founders day', nameAr: 'عطلة' },
        after: { name: 'Founders’ day', nameAr: null },
      });
      expect(audit.every((row) => row.actorId === superAdmin.id && row.requestId)).toBe(true);
      expect(scopes()).toEqual(['calendar', 'calendar', 'calendar', 'calendar']);
    });

    it('an existing date is 409 duplicate with the row to restore (archived ones too)', async () => {
      const api = apiAs(ctx, superAdmin);
      const h = await addHoliday();
      const again = await api.post('/admin/business-hours/holidays', {
        date: h.date,
        name: 'Twice',
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.details).toEqual({
        reason: 'duplicate',
        fields: ['date'],
        existingId: h.id,
        existingIsActive: true,
      });
      const archived = await api.post(`/admin/business-hours/holidays/${h.id}/archive`, {
        expectedUpdatedAt: h.updatedAt,
      });
      const onArchived = await api.post('/admin/business-hours/holidays', {
        date: h.date,
        name: 'Again',
      });
      expect(onArchived.statusCode).toBe(409);
      expect(onArchived.json().error.details).toMatchObject({
        existingId: h.id,
        existingIsActive: false,
      });
      expect(
        await ctx.prisma.holiday.count({ where: { date: new Date(`${h.date}T00:00:00Z`) } }),
      ).toBe(1);
      expect(archived.statusCode).toBe(200);
    });

    it('lists by status and year; validates dates and names; stale edits are 409', async () => {
      const api = apiAs(ctx, superAdmin);
      const kept = await addHoliday();
      const gone = await addHoliday();
      await api.post(`/admin/business-hours/holidays/${gone.id}/archive`, {
        expectedUpdatedAt: gone.updatedAt,
      });
      const list = async (query: string) =>
        holidayListSchema
          .parse((await api.get(`/admin/business-hours/holidays?${query}`)).json())
          .items.map((h) => h.id);
      expect(await list('year=2099')).toContain(kept.id);
      expect(await list('year=2099')).not.toContain(gone.id);
      expect(await list('year=2099&status=archived')).toEqual(expect.arrayContaining([gone.id]));
      expect(await list('year=2099&status=archived')).not.toContain(kept.id);
      expect(await list('year=2099&status=all')).toEqual(
        expect.arrayContaining([kept.id, gone.id]),
      );
      expect(await list('year=2098&status=all')).not.toContain(kept.id);
      const dates = holidayListSchema
        .parse((await api.get('/admin/business-hours/holidays?year=2099&status=all')).json())
        .items.map((h) => h.date);
      expect(dates).toEqual([...dates].sort());

      for (const body of [
        { date: '2099-02-30', name: 'x' },
        { date: '30/01/2099', name: 'x' },
        { date: futureDate(), name: '' },
        { date: futureDate(), name: 'x'.repeat(121) },
      ]) {
        expect((await api.post('/admin/business-hours/holidays', body)).statusCode).toBe(400);
      }
      expect(
        (
          await api.patch(`/admin/business-hours/holidays/${kept.id}`, {
            expectedUpdatedAt: kept.updatedAt,
          })
        ).statusCode,
      ).toBe(400); // nothing to change

      const first = await api.patch(`/admin/business-hours/holidays/${kept.id}`, {
        expectedUpdatedAt: kept.updatedAt,
        name: 'One',
      });
      expect(first.statusCode).toBe(200);
      const second = await api.patch(`/admin/business-hours/holidays/${kept.id}`, {
        expectedUpdatedAt: kept.updatedAt,
        name: 'Two',
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.details.reason).toBe('stale');
      expect(
        (
          await api.patch(`/admin/business-hours/holidays/${randomUUID()}`, {
            expectedUpdatedAt: kept.updatedAt,
            name: 'x',
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  describe('configured business-day length (E12)', () => {
    it('ticket emails say "N business days" in the configured day length', async () => {
      const email = fakeEmail();
      const worker = testWorkerContext(ctx, { emailProvider: email.provider });
      const t = await createTicket(ctx, w.clientX, ticketBody(w)); // P3
      const real = ctx.app.services.ticketConfig;
      // An 8-hour business day (e.g. 08:00–16:00) and an 8-business-hour P3 first reply.
      const configured = (businessDay: number): WorkerContext => ({
        ...worker,
        ticketConfig: {
          ...real,
          getFormConfig: async () => {
            const config = await real.getFormConfig();
            return {
              ...config,
              businessDayMinutes: businessDay,
              slaPolicies: config.slaPolicies.map((p) =>
                p.priority === 'P3' ? { ...p, firstReplyMins: 480, businessHoursOnly: true } : p,
              ),
            };
          },
        },
      });
      const send = async (ctxFor: WorkerContext) => {
        const job = {
          dedupeKey: `test-${randomUUID()}`,
          channel: 'EMAIL',
          template: 'TICKET_CREATED_CLIENT',
          ticketId: t.id,
          userId: w.clientX.id,
        } as const;
        await queueDeliveries(ctxFor, [{ job, recipientMasked: 'x' }]);
        await processDelivery(ctxFor, deliveryJobSchema.parse(job));
        return email.sent.at(-1)!.text;
      };
      expect(await send(configured(480))).toContain('1 business day');
      expect(await send(configured(540))).toContain('8 business hours');
    });
  });
});
