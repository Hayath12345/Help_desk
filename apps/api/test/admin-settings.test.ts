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
import type { AppSetting } from '@loons/db';
import {
  SETTING_KEYS,
  generalSettingsDtoSchema,
  ticketFormConfigSchema,
  type GeneralSettingsDto,
} from '@loons/shared';
import type { WorkerContext } from '../src/jobs/context.ts';
import { registerSchedulers, rescheduleForSettings } from '../src/jobs/schedulers.ts';
import { runSlaScan } from '../src/jobs/sla-scan.ts';
import { SLA_JOBS } from '../src/lib/job-data.ts';
import { canonicalTimeZone } from '../src/services/admin/settings.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';
import { testWorkerContext } from './worker-helpers.ts';

// Admin — General settings (E11): super admins only; the time zone must be an IANA zone, the SOC
// phone an international number (stored in E.164), auto-close 1–60 days, the digest time HH:mm and
// the security category an active category with an active sub-type. The five rows are one form
// (409 stale on the newest `updatedAt`). A time-zone or digest-time change reschedules the worker
// within a minute: the SLA scan tick re-reads both and rewrites the schedulers that follow them.
// The settings are global rows of the shared dev database (a running worker reads them): only the
// SOC phone and the auto-close days are really written here, and restored afterwards; the time
// zone and digest time are exercised through the worker functions on this test's own queues.

describe('admin general settings', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let saved: AppSetting[];
  let broadcast: MockInstance<(event: string, payload: unknown) => void>;

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const team = await f.team();
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    await f.member(team.id, tl.id, 'LEAD');
    superAdmin = await persona(ctx, await f.staff({ staffDomain, role: 'SUPER_ADMIN' }));
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, await f.staff({ staffDomain }));
    client = await persona(ctx, (await f.client()).user);
    // Every general setting as it was: whatever a test (or broken code under test) wrote to these
    // shared rows is put back after each test.
    saved = await ctx.prisma.appSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
    f.onCleanup(async () => {
      await restoreSettings();
      await ctx.prisma.adminAuditLog.deleteMany({
        where: { entity: 'AppSetting', actorId: superAdmin.id },
      });
    });
    broadcast = vi.spyOn(ctx.app.realtime, 'broadcast');
  });
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(() => broadcast.mockClear());
  afterEach(() => restoreSettings());

  /** Puts back any of the five settings that differs from the snapshot. */
  async function restoreSettings() {
    const now = await ctx.prisma.appSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
    for (const row of saved) {
      const current = now.find((r) => r.key === row.key);
      if (current && JSON.stringify(current.value) === JSON.stringify(row.value)) continue;
      await ctx.prisma.appSetting.upsert({
        where: { key: row.key },
        create: { key: row.key, value: row.value as never },
        update: { value: row.value as never },
      });
    }
  }

  const scopes = () =>
    broadcast.mock.calls
      .filter(([event]) => event === 'config:updated')
      .map(([, payload]) => (payload as { scope: string }).scope)
      .sort();
  const get = async (): Promise<GeneralSettingsDto> =>
    generalSettingsDtoSchema.parse((await apiAs(ctx, superAdmin).get('/admin/settings')).json());
  const patch = (dto: GeneralSettingsDto, values: Record<string, unknown>) =>
    apiAs(ctx, superAdmin).patch('/admin/settings', { expectedUpdatedAt: dto.updatedAt, values });

  it('401 without a token; 403 for clients, agents and team leads', async () => {
    expect((await apiAs(ctx).get('/admin/settings')).statusCode).toBe(401);
    const dto = await get();
    for (const who of [client, agent, teamLead]) {
      const api = apiAs(ctx, who);
      expect((await api.get('/admin/settings')).statusCode, who.role).toBe(403);
      const res = await api.patch('/admin/settings', {
        expectedUpdatedAt: dto.updatedAt,
        values: { autoCloseDays: 9 },
      });
      expect(res.statusCode, who.role).toBe(403);
    }
    expect(await get()).toEqual(dto);
  });

  it('returns the five values and the newest updatedAt', async () => {
    const dto = await get();
    expect(Object.keys(dto.values).sort()).toEqual([
      'autoCloseDays',
      'businessTimezone',
      'p4DigestTime',
      'securityCategoryKey',
      'socPhone',
    ]);
    expect(canonicalTimeZone(dto.values.businessTimezone)).toBe(dto.values.businessTimezone);
    const newest = await ctx.prisma.appSetting.aggregate({
      where: {
        key: {
          in: [
            'business.timezone',
            'support.socPhone',
            'tickets.autoCloseDays',
            'notifications.p4DigestTime',
            'tickets.securityCategoryKey',
          ],
        },
      },
      _max: { updatedAt: true },
    });
    expect(dto.updatedAt).toBe(newest._max.updatedAt?.toISOString() ?? null);
  });

  it('validates every value; nothing is written', async () => {
    const dto = await get();
    const team = await ctx.fixtures.team();
    const archived = await ctx.fixtures.category({ teamId: team.id, isActive: false });
    const noSubtype = await ctx.fixtures.category({
      teamId: team.id,
      subtypes: [{ isActive: false }],
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ businessTimezone: 'Mars/Olympus' }, 'validation.timezone'],
      [{ businessTimezone: '+03:00' }, 'validation.timezone'],
      [{ socPhone: '4000 0000' }, 'validation.phone'],
      [{ socPhone: 'call us' }, 'validation.phone'],
      [{ autoCloseDays: 0 }, 'validation.tooSmall'],
      [{ autoCloseDays: 61 }, 'validation.tooLarge'],
      [{ autoCloseDays: 2.5 }, ''],
      [{ p4DigestTime: '7:30' }, 'validation.timeFormat'],
      [{ p4DigestTime: '24:00' }, 'validation.timeFormat'],
      [{ securityCategoryKey: `no-such-${rand(3)}` }, 'validation.securityCategory'],
      [{ securityCategoryKey: archived.category.key }, 'validation.securityCategory'],
      [{ securityCategoryKey: noSubtype.category.key }, 'validation.securityCategory'],
      [{ securityCategoryKey: 'Not A Key' }, 'validation.keyFormat'],
      [{}, 'validation.nothingToChange'],
    ];
    for (const [values, message] of cases) {
      const res = await patch(dto, values);
      expect(res.statusCode, JSON.stringify(values)).toBe(400);
      if (message) expect(JSON.stringify(res.json().error.details), message).toContain(message);
    }
    expect(await get()).toEqual(dto);
    expect(scopes()).toEqual([]);
  });

  it('accepts a valid security category and a zone in any spelling (canonical, unchanged: no write)', async () => {
    const dto = await get();
    const res = await patch(dto, {
      securityCategoryKey: dto.values.securityCategoryKey,
      businessTimezone: dto.values.businessTimezone.toLowerCase(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(generalSettingsDtoSchema.parse(res.json())).toEqual(dto);
    expect(scopes()).toEqual([]);
  });

  it('saves the SOC phone in E.164 and the auto-close days: masked audit rows, scopes, form config', async () => {
    const dto = await get();
    const version = await ctx.app.services.ticketConfig.currentVersion();
    const days = dto.values.autoCloseDays === 7 ? 8 : 7;
    const suffix = String(Math.floor(1000 + Math.random() * 8999));
    const res = await patch(dto, { socPhone: `00974 4000 ${suffix}`, autoCloseDays: days });
    expect(res.statusCode, res.body).toBe(200);
    const after = generalSettingsDtoSchema.parse(res.json());
    expect(after.values).toMatchObject({ socPhone: `+9744000${suffix}`, autoCloseDays: days });
    expect(after.updatedAt).not.toBe(dto.updatedAt);
    expect(scopes()).toEqual(['settings', 'ticket-form']);
    expect(await ctx.app.services.ticketConfig.currentVersion()).toBeGreaterThan(version ?? 0);
    const config = ticketFormConfigSchema.parse(
      (await apiAs(ctx, client).get('/config/ticket-form')).json(),
    );
    expect(config.socPhone).toBe(`+9744000${suffix}`);

    const audit = await ctx.prisma.adminAuditLog.findMany({
      where: { entity: 'AppSetting', actorId: superAdmin.id },
      orderBy: { entityId: 'asc' },
    });
    expect(audit.map((a) => [a.entityId, a.action])).toEqual([
      ['support.socPhone', 'UPDATE'],
      ['tickets.autoCloseDays', 'UPDATE'],
    ]);
    expect(audit[1]).toMatchObject({
      before: { autoCloseDays: dto.values.autoCloseDays },
      after: { autoCloseDays: days },
    });
    // The phone is masked in the audit log.
    expect(JSON.stringify(audit[0])).not.toContain(suffix);

    // A save from the form as it was before: 409 stale, nothing written.
    broadcast.mockClear();
    const stale = await patch(dto, { autoCloseDays: 30 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details).toMatchObject({
      reason: 'stale',
      currentUpdatedAt: after.updatedAt,
    });
    expect((await get()).values.autoCloseDays).toBe(days);
    expect(scopes()).toEqual([]);

    // Clearing the SOC phone.
    const cleared = await patch(after, { socPhone: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().values.socPhone).toBeNull();
  });

  it('a failed audit insert leaves the settings as they were', async () => {
    const dto = await get();
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
    await expect(
      ctx.app.services.admin.settings.update(ghost, {
        expectedUpdatedAt: dto.updatedAt,
        values: { autoCloseDays: dto.values.autoCloseDays === 11 ? 12 : 11 },
      }),
    ).rejects.toThrow();
    expect(await get()).toEqual(dto);
    expect(scopes()).toEqual([]);
  });

  describe('rescheduling (E11)', () => {
    const data = { teamIds: [randomUUID()] };

    async function schedulers() {
      const queue = ctx.queues.sla;
      const [digest, retention, scan] = await Promise.all([
        queue.getJobScheduler(SLA_JOBS.digest),
        queue.getJobScheduler(SLA_JOBS.retention),
        queue.getJobScheduler(SLA_JOBS.scan),
      ]);
      return { digest, retention, scan };
    }

    beforeAll(async () => {
      // This context's own queues (their own Redis prefix), as a worker registers them at start.
      await registerSchedulers(ctx.queues.sla, {
        timeZone: 'Asia/Qatar',
        digestTime: '07:30',
        data,
      });
    });
    afterAll(async () => {
      for (const id of Object.values(SLA_JOBS)) await ctx.queues.sla.removeJobScheduler(id);
    });

    it('rewrites only the schedulers whose timing changed, keeping their data', async () => {
      const before = await schedulers();
      expect(
        await rescheduleForSettings(ctx.queues.sla, {
          timeZone: 'Asia/Qatar',
          digestTime: '07:30',
        }),
      ).toEqual([]);

      expect(
        await rescheduleForSettings(ctx.queues.sla, {
          timeZone: 'Asia/Qatar',
          digestTime: '08:15',
        }),
      ).toEqual([SLA_JOBS.digest]);
      let now = await schedulers();
      expect(now.digest).toMatchObject({ pattern: '15 8 * * *', tz: 'Asia/Qatar' });
      expect(now.digest?.template?.data).toEqual(data);
      expect(now.retention?.next).toBe(before.retention?.next);

      expect(
        await rescheduleForSettings(ctx.queues.sla, {
          timeZone: 'Europe/London',
          digestTime: '08:15',
        }),
      ).toEqual([SLA_JOBS.digest, SLA_JOBS.retention]);
      now = await schedulers();
      expect(now.digest?.tz).toBe('Europe/London');
      expect(now.retention?.tz).toBe('Europe/London');
      expect(now.scan).toEqual(before.scan);
    });

    it('never creates a scheduler a worker did not register', async () => {
      await ctx.queues.sla.removeJobScheduler(SLA_JOBS.retention);
      expect(
        await rescheduleForSettings(ctx.queues.sla, {
          timeZone: 'Asia/Tokyo',
          digestTime: '06:00',
        }),
      ).toEqual([SLA_JOBS.digest]);
      expect(await ctx.queues.sla.getJobScheduler(SLA_JOBS.retention)).toBeUndefined();
      await registerSchedulers(ctx.queues.sla, {
        timeZone: 'Asia/Qatar',
        digestTime: '07:30',
        data,
      });
    });

    it('every SLA scan tick re-reads the time zone and digest time and reschedules', async () => {
      await registerSchedulers(ctx.queues.sla, {
        timeZone: 'Asia/Qatar',
        digestTime: '07:30',
        data,
      });
      const worker = testWorkerContext(ctx);
      const digestTime = (await get()).values.p4DigestTime;
      const [hh, mm] = digestTime.split(':').map(Number);
      // The admin changed the time zone (the calendar is what the worker reads it from).
      const changed: WorkerContext = {
        ...worker,
        ticketConfig: {
          ...worker.ticketConfig,
          getCalendar: async () => ({
            ...(await worker.ticketConfig.getCalendar()),
            timeZone: 'America/New_York',
          }),
        },
      };
      const result = await runSlaScan(changed, { now: new Date(), teamIds: data.teamIds });
      expect(result.schedulersRescheduled.sort()).toEqual(
        [SLA_JOBS.digest, SLA_JOBS.retention].sort(),
      );
      const digest = await ctx.queues.sla.getJobScheduler(SLA_JOBS.digest);
      expect(digest).toMatchObject({ tz: 'America/New_York', pattern: `${mm} ${hh} * * *` });
      // The next tick with nothing new rewrites nothing.
      expect(
        (await runSlaScan(changed, { now: new Date(), teamIds: data.teamIds }))
          .schedulersRescheduled,
      ).toEqual([]);
      // A broken settings read never fails the scan.
      const broken: WorkerContext = {
        ...worker,
        ticketConfig: {
          ...worker.ticketConfig,
          getCalendar: async () => {
            throw new Error('redis down');
          },
        },
      };
      const survived = await runSlaScan(broken, { now: new Date(), teamIds: data.teamIds });
      expect(survived.schedulersRescheduled).toEqual([]);
    });
  });
});
