import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@loons/db';
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATE_KEYS } from '@loons/emails';
import {
  emailTemplateListSchema,
  emailTemplatePreviewDtoSchema,
  emailTemplateResponseSchema,
  type Actor,
} from '@loons/shared';
// The seed file has no imports of its own (the same path import as @loons/emails' parity test).
import { EMAIL_TEMPLATES as SEEDED_TEMPLATES } from '../../../packages/db/prisma/seed-data/email-templates.ts';
import { toEmailTemplateDto } from '../src/services/admin/email-templates.ts';
import { createTestContext, rand, type TestContext } from './helpers.ts';
import { apiAs, persona, type Persona } from './ticket-world.ts';

// Admin — Email templates (decision E14): the twelve fixed keys, text saved per key (row created on
// the first save), placeholders checked against the variables in code, reset to the built-in
// text, a preview rendered by @loons/emails, `expectedUpdatedAt` (null = no row yet), audit rows in
// the same transaction and `config:updated {scope: 'email-templates'}` after commit.
//
// The tests edit the dev database's GOOGLE_LINKED row (a fixed key: there is no test-only
// template) and put it back exactly as it was — id, text, `updatedAt` and `updatedById` — in
// cleanup. Every text written keeps an Arabic subject that names مكتب دعم لونز and a non-empty
// Arabic body, which is all oauth.test.ts (the only other reader of this row) relies on.

const KEY = 'GOOGLE_LINKED';
const PATH = `/admin/email-templates/${KEY}`;
const DEFAULT = DEFAULT_EMAIL_TEMPLATES[KEY];

interface TemplateSnapshot {
  id: string;
  key: string;
  subjectEn: string;
  bodyEn: string;
  subjectAr: string;
  bodyAr: string;
  variables: string[];
  isActive: boolean;
  updatedById: string | null;
  updatedAt: Date;
}

async function snapshot(ctx: TestContext): Promise<TemplateSnapshot | null> {
  return ctx.prisma.emailTemplate.findUnique({ where: { key: KEY } });
}

/** Puts the row back exactly as it was (raw SQL: Prisma would set a new `updatedAt`). */
async function restore(ctx: TestContext, saved: TemplateSnapshot | null): Promise<void> {
  if (!saved) {
    await ctx.prisma.emailTemplate.deleteMany({ where: { key: KEY } });
    return;
  }
  await ctx.prisma.$executeRaw`
    INSERT INTO "EmailTemplate" ("id", "key", "subjectEn", "bodyEn", "subjectAr", "bodyAr",
      "variables", "isActive", "updatedById", "updatedAt")
    VALUES (${saved.id}::uuid, ${saved.key}, ${saved.subjectEn}, ${saved.bodyEn},
      ${saved.subjectAr}, ${saved.bodyAr}, ${saved.variables}, ${saved.isActive},
      ${saved.updatedById}::uuid, ${saved.updatedAt})
    ON CONFLICT ("key") DO UPDATE SET "id" = EXCLUDED."id", "subjectEn" = EXCLUDED."subjectEn",
      "bodyEn" = EXCLUDED."bodyEn", "subjectAr" = EXCLUDED."subjectAr",
      "bodyAr" = EXCLUDED."bodyAr", "variables" = EXCLUDED."variables",
      "isActive" = EXCLUDED."isActive", "updatedById" = EXCLUDED."updatedById",
      "updatedAt" = EXCLUDED."updatedAt"`;
}

const text = (tag: string) => ({
  subjectEn: `Google sign-in added (${tag})`,
  bodyEn: `Hi {{name}},\n\nGoogle sign-in was added (${tag}). Sign in at {{signInUrl}}.`,
  subjectAr: `تمت إضافة Google إلى حسابك في مكتب دعم لونز (${tag})`,
  bodyAr: `مرحباً {{name}}،\n\nتمت إضافة تسجيل الدخول عبر Google (${tag}).`,
});

describe('admin email templates', () => {
  let ctx: TestContext;
  let superAdmin: Persona;
  let teamLead: Persona;
  let agent: Persona;
  let client: Persona;
  let original: TemplateSnapshot | null;

  beforeAll(async () => {
    ctx = await createTestContext();
    const f = ctx.fixtures;
    const staffDomain = ctx.config.staffEmailDomain;
    const team = await f.team();
    const sa = await f.staff({ staffDomain, role: 'SUPER_ADMIN', name: 'Sam Admin' });
    const tl = await f.staff({ staffDomain, role: 'TEAM_LEAD' });
    const ag = await f.staff({ staffDomain, role: 'AGENT' });
    await f.member(team.id, tl.id, 'LEAD');
    await f.member(team.id, ag.id);
    const { user: cl } = await f.client();
    superAdmin = await persona(ctx, sa);
    teamLead = await persona(ctx, tl);
    agent = await persona(ctx, ag);
    client = await persona(ctx, cl);
    original = await snapshot(ctx);
    // Runs before the fixtures delete the test users (updatedById would be nulled by then).
    f.onCleanup(() => restore(ctx, original));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await restore(ctx, original);
    await ctx.prisma.adminAuditLog.deleteMany({ where: { actorId: superAdmin.id } });
  });
  afterAll(async () => {
    await ctx?.close();
  });

  const sa = () => apiAs(ctx, superAdmin);
  const current = async () => emailTemplateResponseSchema.parse((await sa().get(PATH)).json()).item;
  const auditRows = (entityId: string) =>
    ctx.prisma.adminAuditLog.findMany({
      where: { entityId, actorId: superAdmin.id },
      orderBy: { createdAt: 'asc' },
    });
  const configEvents = () => {
    const spy = vi.spyOn(ctx.app.realtime, 'broadcast');
    return () =>
      spy.mock.calls
        .filter(([event]) => event === 'config:updated')
        .map(([, payload]) => payload as { scope: string; version: number });
  };

  describe('access (super admins only)', () => {
    const routes = [
      ['GET', '/admin/email-templates'],
      ['GET', PATH],
      ['PUT', PATH],
      ['POST', `${PATH}/reset`],
      ['POST', `${PATH}/preview`],
    ] as const;
    const call = (api: ReturnType<typeof apiAs>, method: string, url: string) =>
      method === 'GET' ? api.get(url) : method === 'PUT' ? api.put(url, {}) : api.post(url, {});

    it('401 without a token, 403 for clients, agents and team leads on every route', async () => {
      for (const [method, url] of routes) {
        expect((await call(apiAs(ctx), method, url)).statusCode, `${method} ${url}`).toBe(401);
        for (const who of [client, agent, teamLead]) {
          const res = await call(apiAs(ctx, who), method, url);
          expect(res.statusCode, `${who.role} ${method} ${url}`).toBe(403);
        }
      }
    });

    it('the service refuses a non-super-admin even when called directly', async () => {
      const lead: Actor = {
        id: teamLead.id,
        role: 'TEAM_LEAD',
        status: 'ACTIVE',
        orgId: null,
        teamIds: [],
        leadTeamIds: [],
        emailVerified: true,
      };
      await expect(
        ctx.app.services.admin.emailTemplates.list({ actor: lead, requestId: 'r' }),
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('GET', () => {
    it('lists the twelve keys in code order with their variables from code', async () => {
      const res = await sa().get('/admin/email-templates');
      expect(res.statusCode).toBe(200);
      const { items } = emailTemplateListSchema.parse(res.json());
      expect(items.map((i) => i.key)).toEqual([...EMAIL_TEMPLATE_KEYS]);
      const reply = items.find((i) => i.key === 'AGENT_REPLY_CLIENT')!;
      expect(reply.variables).toEqual([...DEFAULT_EMAIL_TEMPLATES.AGENT_REPLY_CLIENT.variables]);
      expect(reply.blockVariables).toEqual(['messageBody']);
      expect(reply.audience).toBe('user');
      expect(items.find((i) => i.key === 'P4_DAILY_DIGEST')?.audience).toBe('list');
      expect(items.find((i) => i.key === 'P4_DAILY_DIGEST')?.blockVariables).toEqual([
        'ticketList',
      ]);
    });

    it('shows the built-in text (and updatedAt null) when no row is stored', async () => {
      await ctx.prisma.emailTemplate.deleteMany({ where: { key: KEY } });
      const item = await current();
      expect(item).toMatchObject({
        key: KEY,
        subjectEn: DEFAULT.subjectEn,
        bodyAr: DEFAULT.bodyAr,
        isCustomized: false,
        updatedAt: null,
        updatedBy: null,
      });
    });

    it('shows the built-in text for an archived (inactive) row, like the senders', async () => {
      const edited = await sa().put(PATH, {
        ...text('x'),
        expectedUpdatedAt: (await current()).updatedAt,
      });
      expect(edited.statusCode).toBe(200);
      await ctx.prisma.emailTemplate.update({ where: { key: KEY }, data: { isActive: false } });
      const item = await current();
      expect(item.subjectEn).toBe(DEFAULT.subjectEn);
      expect(item.isCustomized).toBe(false);
      expect(item.updatedAt).not.toBeNull();
    });

    it('404 for a key that is not one of the twelve; 400 for a malformed one', async () => {
      expect((await sa().get('/admin/email-templates/NOT_A_TEMPLATE')).statusCode).toBe(404);
      expect((await sa().get('/admin/email-templates/constructor')).statusCode).toBe(400);
      const put = await sa().put('/admin/email-templates/NOT_A_TEMPLATE', {
        ...text('x'),
        expectedUpdatedAt: null,
      });
      expect(put.statusCode).toBe(404);
    });
  });

  describe('PUT (save)', () => {
    it('saves the text, records who and when, audits only the changed fields, then announces', async () => {
      const before = await current();
      const events = configEvents();
      const next = { ...before, bodyEn: `${before.bodyEn}\n\nExtra line ${rand()}.` };
      const res = await sa().put(PATH, {
        expectedUpdatedAt: before.updatedAt,
        subjectEn: next.subjectEn,
        bodyEn: next.bodyEn,
        subjectAr: next.subjectAr,
        bodyAr: next.bodyAr,
      });
      expect(res.statusCode).toBe(200);
      const { item } = emailTemplateResponseSchema.parse(res.json());
      expect(item).toMatchObject({
        bodyEn: next.bodyEn,
        isCustomized: true,
        updatedBy: { id: superAdmin.id, name: 'Sam Admin' },
      });
      expect(item.updatedAt).not.toBe(before.updatedAt);

      const row = await ctx.prisma.emailTemplate.findUniqueOrThrow({ where: { key: KEY } });
      expect(row.variables).toEqual([...DEFAULT.variables]);
      expect(row.updatedById).toBe(superAdmin.id);
      expect(row.isActive).toBe(true);

      const [audit, ...more] = await auditRows(row.id);
      expect(more).toEqual([]);
      expect(audit).toMatchObject({
        action: 'UPDATE',
        entity: 'EmailTemplate',
        entityLabel: KEY,
        before: { bodyEn: before.bodyEn },
        after: { bodyEn: next.bodyEn },
      });
      expect(audit!.requestId).toBeTruthy();
      expect(events()).toEqual([{ scope: 'email-templates', version: expect.any(Number) }]);
    });

    it('creates the row on the first save (expectedUpdatedAt null)', async () => {
      await ctx.prisma.emailTemplate.deleteMany({ where: { key: KEY } });
      const res = await sa().put(PATH, { ...text('first'), expectedUpdatedAt: null });
      expect(res.statusCode).toBe(200);
      const row = await ctx.prisma.emailTemplate.findUniqueOrThrow({ where: { key: KEY } });
      expect(row.subjectEn).toBe(text('first').subjectEn);
      const [audit] = await auditRows(row.id);
      // Compared with the built-in text the senders used before.
      expect(audit).toMatchObject({
        action: 'UPDATE',
        before: { subjectEn: DEFAULT.subjectEn },
        after: { subjectEn: text('first').subjectEn },
      });
    });

    it('two first saves at once: one wins, the other is stale', async () => {
      await ctx.prisma.emailTemplate.deleteMany({ where: { key: KEY } });
      const results = await Promise.all([
        sa().put(PATH, { ...text('a'), expectedUpdatedAt: null }),
        sa().put(PATH, { ...text('b'), expectedUpdatedAt: null }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.statusCode === 409)!;
      expect(loser.json().error.details.reason).toBe('stale');
    });

    it('409 stale when the row changed since the edit started (E19)', async () => {
      const start = await current();
      const first = await sa().put(PATH, { ...text('one'), expectedUpdatedAt: start.updatedAt });
      expect(first.statusCode).toBe(200);
      const saved = emailTemplateResponseSchema.parse(first.json()).item;

      const second = await sa().put(PATH, { ...text('two'), expectedUpdatedAt: start.updatedAt });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.details).toEqual({
        reason: 'stale',
        currentUpdatedAt: saved.updatedAt,
      });
      // "No row" is stale too once a row exists, and vice versa.
      expect(
        (await sa().put(PATH, { ...text('x'), expectedUpdatedAt: null })).json().error.details
          .reason,
      ).toBe('stale');
      await ctx.prisma.emailTemplate.deleteMany({ where: { key: KEY } });
      const gone = await sa().put(PATH, { ...text('x'), expectedUpdatedAt: saved.updatedAt });
      expect(gone.statusCode).toBe(409);
      expect((await current()).subjectEn).toBe(DEFAULT.subjectEn);
    });

    it('refuses unknown placeholders and block variables in a subject, writing nothing', async () => {
      const before = await current();
      const events = configEvents();
      const res = await sa().put(PATH, {
        expectedUpdatedAt: before.updatedAt,
        subjectEn: 'Hello {{ticketNumber}}',
        bodyEn: 'Hi {{name}} {{signInUrl}}',
        subjectAr: 'مكتب دعم لونز',
        bodyAr: 'مرحباً {{secret}} {{name}}',
      });
      expect(res.statusCode).toBe(400);
      const issues = res.json().error.details as Array<Record<string, unknown>>;
      expect(issues).toEqual([
        expect.objectContaining({
          path: ['subjectEn'],
          code: 'unknown_variable',
          message: 'validation.unknownVariable',
        }),
        expect.objectContaining({ path: ['bodyAr'], code: 'unknown_variable' }),
      ]);
      expect(await current()).toEqual(before);
      expect(events()).toEqual([]);

      // A block variable is fine in the body of AGENT_REPLY_CLIENT, never in its subject.
      const reply = emailTemplateResponseSchema.parse(
        (await sa().get('/admin/email-templates/AGENT_REPLY_CLIENT')).json(),
      ).item;
      const block = await sa().put('/admin/email-templates/AGENT_REPLY_CLIENT', {
        expectedUpdatedAt: reply.updatedAt,
        subjectEn: 'Reply: {{messageBody}}',
        bodyEn: reply.bodyEn,
        subjectAr: reply.subjectAr,
        bodyAr: reply.bodyAr,
      });
      expect(block.statusCode).toBe(400);
      expect(block.json().error.details).toEqual([
        expect.objectContaining({
          path: ['subjectEn'],
          code: 'block_in_subject',
          message: 'validation.blockInSubject',
        }),
      ]);
    });

    // Review api-comms-3: brace text that isn't a placeholder would be sent as typed.
    it('refuses malformed placeholders, writing nothing', async () => {
      const before = await current();
      const res = await sa().put(PATH, {
        ...text('x'),
        subjectEn: '[{{sign-in}}] Google {{name}',
        bodyEn: 'Hi {{name}}}, sign in at {{signInUrl}}.',
        expectedUpdatedAt: before.updatedAt,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual([
        expect.objectContaining({
          path: ['subjectEn'],
          code: 'malformed_placeholder',
          message: 'validation.malformedPlaceholder',
        }),
        expect.objectContaining({ path: ['subjectEn'], code: 'malformed_placeholder' }),
        expect.objectContaining({ path: ['bodyEn'], code: 'malformed_placeholder' }),
      ]);
      expect(await current()).toEqual(before);
    });

    // Review api-comms-1: P1 rows seeded before the Phase 3 wording change still use
    // {{escalationMins}}, {{minutesUnacknowledged}} and {{consoleUrl}} (the worker still fills
    // them). Saving such text back — unchanged, or with one word edited — must not be refused.
    describe('pre-rename P1 placeholders', () => {
      const P1_TEXT = {
        P1_ALERT: {
          subjectEn: 'P1 CRITICAL [{{ticketNumber}}] {{ticketSubject}} — {{orgName}}',
          bodyEn:
            'Hi {{name}},\n\nAcknowledge: {{ackUrl}}\nOpen in the console: {{consoleUrl}}\n\nIf nobody acknowledges within {{escalationMins}} minutes, the ticket escalates.',
          subjectAr: 'P1 حرجة [{{ticketNumber}}] {{ticketSubject}} — {{orgName}}',
          bodyAr:
            'مرحبًا {{name}}،\n\nفتح في وحدة التحكم: {{consoleUrl}}\n\nإذا لم يؤكد أحد الاستلام خلال {{escalationMins}} دقيقة، تُصعَّد التذكرة.',
        },
        P1_ESCALATION: {
          subjectEn:
            'ESCALATION (step {{step}}) — P1 [{{ticketNumber}}] unacknowledged for {{minutesUnacknowledged}} min',
          bodyEn:
            'Hi {{name}},\n\nNot acknowledged after {{minutesUnacknowledged}} minutes.\n\nOpen in the console: {{consoleUrl}}',
          subjectAr:
            'تصعيد (الخطوة {{step}}) — P1 [{{ticketNumber}}] دون تأكيد استلام منذ {{minutesUnacknowledged}} دقيقة',
          bodyAr: 'مرحبًا {{name}}،\n\nبعد مرور {{minutesUnacknowledged}} دقيقة.\n\n{{consoleUrl}}',
        },
      } as const;

      it('passes the placeholder check (a stale version then answers 409, not 400)', async () => {
        for (const key of ['P1_ALERT', 'P1_ESCALATION'] as const) {
          const res = await sa().put(`/admin/email-templates/${key}`, {
            ...P1_TEXT[key],
            // Never the row's version: the request stops at the stale check, nothing is written.
            expectedUpdatedAt: '2001-01-01T00:00:00.000Z',
          });
          expect(res.statusCode, `${key} ${res.body}`).toBe(409);
          expect(res.json().error.details.reason).toBe('stale');
        }
        // Each name only where its sender fills it.
        const other = await sa().put('/admin/email-templates/P1_ESCALATION', {
          ...P1_TEXT.P1_ESCALATION,
          bodyEn: 'Within {{escalationMins}} minutes.',
          expectedUpdatedAt: '2001-01-01T00:00:00.000Z',
        });
        expect(other.statusCode).toBe(400);
        expect(other.json().error.details).toEqual([
          expect.objectContaining({ path: ['bodyEn'], code: 'unknown_variable' }),
        ]);
      });

      it('lists them as legacy variables, not as variables to insert', async () => {
        const item = emailTemplateResponseSchema.parse(
          (await sa().get('/admin/email-templates/P1_ESCALATION')).json(),
        ).item;
        expect(item.legacyVariables).toEqual(['minutesUnacknowledged', 'consoleUrl']);
        expect(item.variables).not.toContain('minutesUnacknowledged');
        expect((await current()).legacyVariables).toEqual([]);
      });

      it('saves the stored text back unchanged (200, nothing written)', async () => {
        for (const key of ['P1_ALERT', 'P1_ESCALATION'] as const) {
          const path = `/admin/email-templates/${key}`;
          const before = emailTemplateResponseSchema.parse((await sa().get(path)).json()).item;
          const res = await sa().put(path, {
            expectedUpdatedAt: before.updatedAt,
            subjectEn: before.subjectEn,
            bodyEn: before.bodyEn,
            subjectAr: before.subjectAr,
            bodyAr: before.bodyAr,
          });
          expect(res.statusCode, `${key} ${res.body}`).toBe(200);
          expect(emailTemplateResponseSchema.parse(res.json()).item.updatedAt).toBe(
            before.updatedAt,
          );
        }
      });
    });

    it('validates the body: English required, lengths capped', async () => {
      const before = await current();
      const empty = await sa().put(PATH, {
        ...text('x'),
        subjectEn: '  ',
        expectedUpdatedAt: before.updatedAt,
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.details[0]).toMatchObject({
        path: ['subjectEn'],
        message: 'validation.required',
      });
      const long = await sa().put(PATH, {
        ...text('x'),
        subjectAr: 'س'.repeat(201),
        expectedUpdatedAt: before.updatedAt,
      });
      expect(long.statusCode).toBe(400);
      expect(long.json().error.details[0]).toMatchObject({ path: ['subjectAr'] });
      expect((await sa().put(PATH, text('x'))).statusCode).toBe(400); // no expectedUpdatedAt
    });

    it('an unchanged save writes nothing (no audit row, same updatedAt, no announcement)', async () => {
      const start = await current();
      const saved = emailTemplateResponseSchema.parse(
        (await sa().put(PATH, { ...text('same'), expectedUpdatedAt: start.updatedAt })).json(),
      ).item;
      const rowId = (await ctx.prisma.emailTemplate.findUniqueOrThrow({ where: { key: KEY } })).id;
      const audits = (await auditRows(rowId)).length;
      const events = configEvents();
      const again = await sa().put(PATH, { ...text('same'), expectedUpdatedAt: saved.updatedAt });
      expect(again.statusCode).toBe(200);
      expect(emailTemplateResponseSchema.parse(again.json()).item.updatedAt).toBe(saved.updatedAt);
      expect(await auditRows(rowId)).toHaveLength(audits);
      expect(events()).toEqual([]);
    });

    it('a failed write leaves no audit row and no change (same transaction)', async () => {
      const before = await current();
      const ghost: Actor = {
        id: crypto.randomUUID(), // no such user: the row's updatedById foreign key fails
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        orgId: null,
        teamIds: [],
        leadTeamIds: [],
        emailVerified: true,
      };
      const events = configEvents();
      await expect(
        ctx.app.services.admin.emailTemplates.update(
          { actor: ghost, requestId: `req-${rand()}` },
          KEY,
          { ...text('ghost'), expectedUpdatedAt: before.updatedAt },
        ),
      ).rejects.toBeTruthy();
      expect(await current()).toEqual(before);
      expect(await ctx.prisma.adminAuditLog.count({ where: { actorId: ghost.id } })).toBe(0);
      expect(events()).toEqual([]);
    });
  });

  describe('POST reset', () => {
    it('puts the built-in text back, audited and announced; a second reset changes nothing', async () => {
      const start = await current();
      const custom = emailTemplateResponseSchema.parse(
        (await sa().put(PATH, { ...text('custom'), expectedUpdatedAt: start.updatedAt })).json(),
      ).item;
      expect(custom.isCustomized).toBe(true);

      const events = configEvents();
      const res = await sa().post(`${PATH}/reset`, { expectedUpdatedAt: custom.updatedAt });
      expect(res.statusCode).toBe(200);
      const { item } = emailTemplateResponseSchema.parse(res.json());
      expect(item).toMatchObject({
        subjectEn: DEFAULT.subjectEn,
        bodyEn: DEFAULT.bodyEn,
        subjectAr: DEFAULT.subjectAr,
        bodyAr: DEFAULT.bodyAr,
        isCustomized: false,
      });
      const row = await ctx.prisma.emailTemplate.findUniqueOrThrow({ where: { key: KEY } });
      const audits = await auditRows(row.id);
      expect(audits.at(-1)).toMatchObject({
        action: 'UPDATE',
        before: { subjectEn: text('custom').subjectEn },
        after: { subjectEn: DEFAULT.subjectEn },
      });
      expect(events()).toEqual([{ scope: 'email-templates', version: expect.any(Number) }]);

      const again = await sa().post(`${PATH}/reset`, { expectedUpdatedAt: item.updatedAt });
      expect(again.statusCode).toBe(200);
      expect(await auditRows(row.id)).toHaveLength(audits.length);
    });

    it('409 stale on an old expectedUpdatedAt', async () => {
      const start = await current();
      await sa().put(PATH, { ...text('custom'), expectedUpdatedAt: start.updatedAt });
      const res = await sa().post(`${PATH}/reset`, { expectedUpdatedAt: start.updatedAt });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.reason).toBe('stale');
      expect((await current()).subjectEn).toBe(text('custom').subjectEn);
    });
  });

  describe('POST preview', () => {
    it('renders unsaved text with sample values, in the language asked, saving nothing', async () => {
      const before = await current();
      const res = await sa().post(`${PATH}/preview`, {
        locale: 'en',
        subject: 'Preview for {{name}}',
        body: 'Hi {{name}},\n\nUnsaved wording. Sign in at {{signInUrl}}.',
      });
      expect(res.statusCode).toBe(200);
      const preview = emailTemplatePreviewDtoSchema.parse(res.json());
      expect(preview.subject).toBe('Preview for Dana Haddad');
      expect(preview.text).toContain('Unsaved wording.');
      expect(preview.text).toContain(`${ctx.config.appUrl}/login`);
      expect(preview.html).toMatch(/<html[^>]*dir="ltr"/);
      expect(await current()).toEqual(before);

      const ar = emailTemplatePreviewDtoSchema.parse(
        (
          await sa().post(`${PATH}/preview`, {
            locale: 'ar',
            subject: DEFAULT.subjectAr,
            body: DEFAULT.bodyAr,
          })
        ).json(),
      );
      expect(ar.html).toMatch(/<html[^>]*dir="rtl"/);
      expect(ar.text).toContain('دانة حداد');
    });

    it('validates the draft (locale, length) and the key', async () => {
      expect(
        (await sa().post(`${PATH}/preview`, { locale: 'fr', subject: '', body: '' })).statusCode,
      ).toBe(400);
      expect(
        (
          await sa().post(`${PATH}/preview`, {
            locale: 'en',
            subject: 'x'.repeat(201),
            body: '',
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await sa().post('/admin/email-templates/NOT_A_TEMPLATE/preview', {
            locale: 'en',
            subject: '',
            body: '',
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  it('is in the OpenAPI document under the admin tag', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    const paths = res.json().paths as Record<string, Record<string, { tags?: string[] }>>;
    expect(paths['/admin/email-templates/{key}']?.put?.tags).toEqual(['admin']);
    expect(paths['/admin/email-templates/{key}/preview']?.post?.tags).toEqual(['admin']);
  });
});

// Keeps the snapshot type honest against the Prisma model.
void ((row: Prisma.EmailTemplateGetPayload<object>): TemplateSnapshot => row);

// Review api-comms-2: a freshly seeded row is the built-in text, so no template shows as
// "Customized" (nor offers a Reset that would change live emails) until an admin edits it.
describe('seeded rows', () => {
  it('are not customized, for every key', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const seed = SEEDED_TEMPLATES.find((t) => t.key === key);
      expect(seed, key).toBeDefined();
      const dto = toEmailTemplateDto(key, {
        id: crypto.randomUUID(),
        key,
        subjectEn: seed!.subjectEn,
        bodyEn: seed!.bodyEn,
        subjectAr: seed!.subjectAr,
        bodyAr: seed!.bodyAr,
        isActive: true,
        updatedAt: new Date(),
        updatedBy: null,
      });
      expect(dto.isCustomized, key).toBe(false);
    }
  });
});
