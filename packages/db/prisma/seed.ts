// `pnpm db:seed` → `prisma db seed` → `tsx prisma/seed.ts` (root .env loaded by prisma.config.ts).
//
// CREATE-ONLY and idempotent: every row is keyed on a unique column (or a deterministic key such as
// escalation priority + step, message clientTempId "seed:LG-4817:1") and only created when missing;
// existing rows are never updated, so admin edits made later survive re-runs. Join rows (field ↔
// category links, team memberships, on-call) are only added together with the parent row created in
// the same run, and holidays only into a year that has none, so an admin's removals and date
// corrections are not undone either.
//
// Part 1 — CONFIG (always): teams, categories, sub-types, custom fields, SLA policies, business
//   hours, holidays, app settings, P1 escalation chain, macros, email templates, help articles, tags.
//   Optional production bootstrap: SEED_ADMIN_EMAIL (+ SEED_ADMIN_NAME) creates the first
//   SSO-only SUPER_ADMIN so someone can sign in with Entra ID and configure the rest.
// Part 2 — DEMO (opt-in: SEED_DEMO_DATA=true and NODE_ENV explicitly development/test): organisations,
//   sites, staff and client users (password SEED_DEMO_PASSWORD, email already verified), team
//   memberships, on-call users, and the design's tickets with messages and history.

import { formatTicketNumber, isStaffEmail, newPasswordSchema, normalizeEmail } from '@loons/shared';
import { createPrismaClient, hashPassword, type Prisma, type PrismaClient } from '../src/index.ts';
import { CATEGORIES } from './seed-data/categories.ts';
import { CUSTOM_FIELDS } from './seed-data/custom-fields.ts';
import {
  DEMO_CLIENTS,
  DEMO_ORGS,
  DEMO_SKILLS,
  DEMO_STAFF,
  DEMO_TEAM_STAFFING,
  DEMO_TICKETS,
  NEXT_TICKET_NUMBER,
  OPERATIONS_MANAGER_EMAIL,
  type DemoTicketSeed,
  type DemoUserSeed,
} from './seed-data/demo.ts';
import { EMAIL_TEMPLATES } from './seed-data/email-templates.ts';
import { HELP_ARTICLES } from './seed-data/help-articles.ts';
import { HOLIDAY_YEARS, HOLIDAYS } from './seed-data/holidays.ts';
import { MACROS } from './seed-data/macros.ts';
import { isNonProductionEnv, seedOptions, type SeedOptions } from './seed-data/options.ts';
import {
  APP_SETTINGS,
  BUSINESS_HOURS,
  P1_ESCALATION_STEPS,
  SLA_POLICIES,
} from './seed-data/sla.ts';
import { TAGS } from './seed-data/tags.ts';
import { TEAMS } from './seed-data/teams.ts';
import { buildTicketTimeline } from './seed-data/ticket-timeline.ts';
import { utcDate } from './seed-data/util.ts';

type Tx = Prisma.TransactionClient;

const DEFAULT_DEMO_PASSWORD = 'LoonsDemo2026';
const TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

// ───────────────────────────── helpers ─────────────────────────────

function log(line: string): void {
  process.stdout.write(`[seed] ${line}\n`);
}

/** Create-only primitive that also reports whether the row was created in this run. */
async function createIfMissing<T>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<{ row: T; created: boolean }> {
  const existing = await find();
  if (existing) return { row: existing, created: false };
  return { row: await create(), created: true };
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Seed lookup failed: ${what}`);
  return value;
}

// ───────────────────────────── row counts (summary) ─────────────────────────────

const COUNTED_TABLES = {
  config: {
    teams: (db: PrismaClient) => db.team.count(),
    categories: (db: PrismaClient) => db.category.count(),
    subtypes: (db: PrismaClient) => db.subtype.count(),
    customFields: (db: PrismaClient) => db.customField.count(),
    categoryFields: (db: PrismaClient) => db.categoryField.count(),
    slaPolicies: (db: PrismaClient) => db.slaPolicy.count(),
    businessHours: (db: PrismaClient) => db.businessHours.count(),
    holidays: (db: PrismaClient) => db.holiday.count(),
    appSettings: (db: PrismaClient) => db.appSetting.count(),
    escalationRules: (db: PrismaClient) => db.escalationRule.count(),
    macros: (db: PrismaClient) => db.macro.count(),
    emailTemplates: (db: PrismaClient) => db.emailTemplate.count(),
    helpArticles: (db: PrismaClient) => db.helpArticle.count(),
    tags: (db: PrismaClient) => db.tag.count(),
  },
  demo: {
    organizations: (db: PrismaClient) => db.organization.count(),
    sites: (db: PrismaClient) => db.site.count(),
    users: (db: PrismaClient) => db.user.count(),
    teamMembers: (db: PrismaClient) => db.teamMember.count(),
    skills: (db: PrismaClient) => db.skill.count(),
    userSkills: (db: PrismaClient) => db.userSkill.count(),
    tickets: (db: PrismaClient) => db.ticket.count(),
    ticketTags: (db: PrismaClient) => db.ticketTag.count(),
    messages: (db: PrismaClient) => db.message.count(),
    ticketEvents: (db: PrismaClient) => db.ticketEvent.count(),
  },
} as const;

type Counts = Record<string, number>;

async function countRows(db: PrismaClient, group: keyof typeof COUNTED_TABLES): Promise<Counts> {
  const entries = Object.entries(COUNTED_TABLES[group]);
  const values = await Promise.all(entries.map(([, count]) => count(db)));
  return Object.fromEntries(entries.map(([name], i) => [name, values[i] ?? 0]));
}

function formatCounts(before: Counts, after: Counts): string {
  return Object.keys(after)
    .map((name) => `${name} ${after[name]} (+${(after[name] ?? 0) - (before[name] ?? 0)})`)
    .join(', ');
}

// ───────────────────────────── part 1: config ─────────────────────────────

async function seedTeams(tx: Tx): Promise<void> {
  for (const [i, t] of TEAMS.entries()) {
    await tx.team.upsert({
      where: { key: t.key },
      update: {},
      create: { key: t.key, nameEn: t.nameEn, nameAr: t.nameAr, emails: t.emails, sortOrder: i },
    });
  }
}

async function seedCategories(tx: Tx): Promise<void> {
  const teams = await tx.team.findMany({ select: { id: true, key: true } });
  const teamIdByKey = new Map(teams.map((t) => [t.key, t.id]));

  for (const [i, c] of CATEGORIES.entries()) {
    const category = await tx.category.upsert({
      where: { key: c.key },
      update: {},
      create: {
        key: c.key,
        labelEn: c.labelEn,
        labelAr: c.labelAr,
        icon: c.icon,
        assetPlaceholder: c.assetPlaceholder,
        teamId: must(teamIdByKey.get(c.teamKey), `team ${c.teamKey}`),
        sortOrder: i,
      },
      select: { id: true },
    });
    for (const [j, s] of c.subtypes.entries()) {
      await tx.subtype.upsert({
        where: { categoryId_key: { categoryId: category.id, key: s.key } },
        update: {},
        create: {
          categoryId: category.id,
          key: s.key,
          labelEn: s.labelEn,
          labelAr: s.labelAr,
          defaultPriority: s.defaultPriority,
          sortOrder: j,
        },
      });
    }
  }
}

async function seedCustomFields(tx: Tx): Promise<void> {
  const categories = await tx.category.findMany({ select: { id: true, key: true } });
  const categoryIdByKey = new Map(categories.map((c) => [c.key, c.id]));

  for (const f of CUSTOM_FIELDS) {
    const { row: field, created } = await createIfMissing(
      () => tx.customField.findUnique({ where: { key: f.key }, select: { id: true } }),
      () =>
        tx.customField.create({
          data: {
            key: f.key,
            labelEn: f.labelEn,
            labelAr: f.labelAr,
            type: f.type,
            placeholderEn: f.placeholderEn,
            placeholderAr: f.placeholderAr,
            required: f.required,
          },
          select: { id: true },
        }),
    );
    // Links only accompany a newly created field (an admin may have unlinked it since).
    if (!created) continue;
    await tx.categoryField.createMany({
      data: f.categoryKeys.map((key, sortOrder) => ({
        categoryId: must(categoryIdByKey.get(key), `category ${key}`),
        fieldId: field.id,
        sortOrder,
      })),
      skipDuplicates: true,
    });
  }
}

async function seedSlaAndCalendar(tx: Tx): Promise<void> {
  for (const p of SLA_POLICIES) {
    await tx.slaPolicy.upsert({ where: { priority: p.priority }, update: {}, create: { ...p } });
  }
  for (const h of BUSINESS_HOURS) {
    await tx.businessHours.upsert({ where: { weekday: h.weekday }, update: {}, create: { ...h } });
  }
  // Holidays are seeded per calendar year, and only into a year that has none yet (archived rows
  // count): admins move the estimated Eid dates once the moon is sighted, and a date-keyed re-seed
  // would bring back the estimate next to the corrected day.
  for (const year of HOLIDAY_YEARS) {
    const inYear = HOLIDAYS.filter((h) => h.date.getUTCFullYear() === year);
    const existing = await tx.holiday.count({
      where: { date: { gte: utcDate(year, 1, 1), lt: utcDate(year + 1, 1, 1) } },
    });
    if (existing > 0) continue;
    await tx.holiday.createMany({
      data: inYear.map((h) => ({ date: h.date, name: h.name, nameAr: h.nameAr })),
      skipDuplicates: true,
    });
  }
  for (const s of APP_SETTINGS) {
    await tx.appSetting.upsert({
      where: { key: s.key },
      update: {},
      create: { key: s.key, value: s.value },
    });
  }
}

/**
 * P1 chain (teamId = null), keyed by (priority, step). Steps targeting the operations manager need
 * a user and are created by `seedManagerEscalationSteps` once one can be resolved.
 */
async function seedEscalationRules(tx: Tx): Promise<void> {
  for (const s of P1_ESCALATION_STEPS) {
    if (s.targetsOperationsManager) continue;
    const existing = await tx.escalationRule.findFirst({
      where: { priority: s.priority, teamId: null, step: s.step },
      select: { id: true },
    });
    if (existing) continue;
    await tx.escalationRule.create({
      data: {
        priority: s.priority,
        step: s.step,
        targetType: s.targetType,
        targetRole: s.targetRole,
        afterMins: s.afterMins,
        channels: [...s.channels],
      },
    });
  }
}

async function seedContent(tx: Tx): Promise<void> {
  for (const [i, m] of MACROS.entries()) {
    await tx.macro.upsert({
      where: { key: m.key },
      update: {},
      create: {
        key: m.key,
        titleEn: m.titleEn,
        titleAr: m.titleAr,
        bodyEn: m.bodyEn,
        bodyAr: m.bodyAr,
        setStatus: m.setStatus,
        sortOrder: i,
      },
    });
  }
  for (const t of EMAIL_TEMPLATES) {
    await tx.emailTemplate.upsert({
      where: { key: t.key },
      update: {},
      create: {
        key: t.key,
        subjectEn: t.subjectEn,
        bodyEn: t.bodyEn,
        subjectAr: t.subjectAr,
        bodyAr: t.bodyAr,
        variables: [...t.variables],
      },
    });
  }
  for (const [i, a] of HELP_ARTICLES.entries()) {
    await tx.helpArticle.upsert({
      where: { key: a.key },
      update: {},
      create: { ...a, sortOrder: i },
    });
  }
  for (const t of TAGS) {
    await tx.tag.upsert({
      where: { key: t.key },
      update: {},
      create: { key: t.key, label: t.label },
    });
  }
}

/** Optional first SUPER_ADMIN for a fresh (production) install; SSO-only, no password. */
async function seedBootstrapAdmin(tx: Tx, options: SeedOptions): Promise<void> {
  const raw = process.env.SEED_ADMIN_EMAIL?.trim();
  if (!raw) return;
  const email = normalizeEmail(raw);
  if (!isStaffEmail(email, options.staffEmailDomain)) {
    throw new Error('SEED_ADMIN_EMAIL must be an address on STAFF_EMAIL_DOMAIN');
  }
  await tx.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: process.env.SEED_ADMIN_NAME?.trim() || 'Operations Manager',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      jobTitle: 'Operations Manager',
      emailVerifiedAt: new Date(),
    },
  });
}

async function seedConfig(db: PrismaClient, options: SeedOptions): Promise<void> {
  await db.$transaction(async (tx) => {
    await seedTeams(tx);
    await seedCategories(tx);
    await seedCustomFields(tx);
    await seedSlaAndCalendar(tx);
    await seedEscalationRules(tx);
    await seedContent(tx);
    await seedBootstrapAdmin(tx, options);
  }, TX_OPTIONS);
}

// ───────────────────────────── part 2: demo ─────────────────────────────

function demoPassword(): string {
  const password = process.env.SEED_DEMO_PASSWORD || DEFAULT_DEMO_PASSWORD;
  if (!newPasswordSchema.safeParse(password).success) {
    throw new Error(
      'SEED_DEMO_PASSWORD does not meet the password policy (10–128 characters, letters and digits)',
    );
  }
  return password;
}

/** argon2id hashes for the demo users that don't exist yet (hashing is slow, so only those). */
async function hashesForMissingUsers(
  db: PrismaClient,
  users: readonly DemoUserSeed[],
): Promise<Map<string, string>> {
  const existing = await db.user.findMany({
    where: { email: { in: users.map((u) => u.email) } },
    select: { email: true },
  });
  const existingEmails = new Set(existing.map((u) => u.email));
  const missing = users.filter((u) => !existingEmails.has(u.email));
  if (missing.length === 0) return new Map();
  const password = demoPassword();
  const hashes = await Promise.all(missing.map(() => hashPassword(password)));
  return new Map(missing.map((u, i) => [u.email, hashes[i] ?? '']));
}

async function seedDemoPeople(db: PrismaClient): Promise<void> {
  const hashes = await hashesForMissingUsers(db, [...DEMO_STAFF, ...DEMO_CLIENTS]);
  const verifiedAt = new Date();

  await db.$transaction(async (tx) => {
    const createUser = async (u: DemoUserSeed, orgId: string | null) =>
      createIfMissing(
        () => tx.user.findUnique({ where: { email: u.email }, select: { id: true } }),
        () =>
          tx.user.create({
            data: {
              email: u.email,
              name: u.name,
              role: u.role,
              status: 'ACTIVE',
              orgId,
              locale: u.locale,
              phone: u.phone,
              jobTitle: u.jobTitle,
              passwordHash: must(hashes.get(u.email), 'demo password hash'),
              emailVerifiedAt: verifiedAt,
            },
            select: { id: true },
          }),
      );

    // Staff first: they are the organisations' account managers.
    const staffIds = new Map<string, string>();
    const newStaff = new Set<string>();
    for (const s of DEMO_STAFF) {
      const { row, created } = await createUser(s, null);
      staffIds.set(s.email, row.id);
      if (created) newStaff.add(s.email);
    }

    // Memberships and on-call duty accompany newly created staff only.
    const teams = await tx.team.findMany({ select: { id: true, key: true } });
    const teamIdByKey = new Map(teams.map((t) => [t.key, t.id]));
    for (const staffing of DEMO_TEAM_STAFFING) {
      const teamId = must(teamIdByKey.get(staffing.teamKey), `team ${staffing.teamKey}`);
      for (const m of staffing.members) {
        if (!newStaff.has(m.email)) continue;
        const userId = must(staffIds.get(m.email), 'staff user');
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId, userId } },
          update: {},
          create: { teamId, userId, role: m.role },
        });
      }
      if (newStaff.has(staffing.onCallEmail)) {
        await tx.team.updateMany({
          where: { id: teamId, onCallUserId: null },
          data: { onCallUserId: must(staffIds.get(staffing.onCallEmail), 'on-call user') },
        });
      }
    }

    // The starter skills: a skill's links to staff are added only in the run that creates it, so
    // an admin's later removals are not undone.
    for (const skill of DEMO_SKILLS) {
      const { row, created } = await createIfMissing(
        () => tx.skill.findUnique({ where: { key: skill.key }, select: { id: true } }),
        () =>
          tx.skill.create({
            data: { key: skill.key, labelEn: skill.labelEn, labelAr: skill.labelAr },
            select: { id: true },
          }),
      );
      if (!created) continue;
      for (const email of skill.staffEmails) {
        await tx.userSkill.create({
          data: { userId: must(staffIds.get(email), 'skill staff'), skillId: row.id },
        });
      }
    }

    const orgIds = new Map<string, string>();
    for (const o of DEMO_ORGS) {
      const org = await tx.organization.upsert({
        where: { key: o.key },
        update: {},
        create: {
          key: o.key,
          name: o.name,
          nameAr: o.nameAr,
          contractType: o.contractType,
          amcExpiry: o.amcExpiry,
          accountManagerId: must(staffIds.get(o.accountManagerEmail), 'account manager'),
          emailDomains: o.emailDomains,
        },
        select: { id: true },
      });
      orgIds.set(o.key, org.id);
      for (const [i, s] of o.sites.entries()) {
        await tx.site.upsert({
          where: { orgId_key: { orgId: org.id, key: s.key } },
          update: {},
          create: { orgId: org.id, key: s.key, name: s.name, nameAr: s.nameAr, sortOrder: i },
        });
      }
    }

    for (const c of DEMO_CLIENTS) {
      await createUser(c, must(orgIds.get(c.orgKey), `org ${c.orgKey}`));
    }
  }, TX_OPTIONS);
}

interface DemoLookups {
  userIdByEmail: Map<string, string>;
  orgIdByKey: Map<string, string>;
  siteIdByOrgKey: Map<string, string>;
  categoryByKey: Map<string, { id: string; teamId: string }>;
  subtypeIdByCategoryKey: Map<string, string>;
  tagIdByKey: Map<string, string>;
}

async function loadDemoLookups(db: PrismaClient): Promise<DemoLookups> {
  const [users, orgs, sites, categories, subtypes, tags] = await Promise.all([
    db.user.findMany({
      where: { email: { in: [...DEMO_STAFF, ...DEMO_CLIENTS].map((u) => u.email) } },
      select: { id: true, email: true },
    }),
    db.organization.findMany({ select: { id: true, key: true } }),
    db.site.findMany({ select: { id: true, key: true, orgId: true } }),
    db.category.findMany({ select: { id: true, key: true, teamId: true } }),
    db.subtype.findMany({ select: { id: true, key: true, categoryId: true } }),
    db.tag.findMany({ select: { id: true, key: true } }),
  ]);
  return {
    userIdByEmail: new Map(users.map((u) => [u.email, u.id])),
    orgIdByKey: new Map(orgs.map((o) => [o.key, o.id])),
    siteIdByOrgKey: new Map(sites.map((s) => [`${s.orgId}:${s.key}`, s.id])),
    categoryByKey: new Map(categories.map((c) => [c.key, { id: c.id, teamId: c.teamId }])),
    subtypeIdByCategoryKey: new Map(subtypes.map((s) => [`${s.categoryId}:${s.key}`, s.id])),
    tagIdByKey: new Map(tags.map((t) => [t.key, t.id])),
  };
}

/** Creates one demo ticket with its tags, messages and history; skips it if the number exists. */
async function seedDemoTicket(
  db: PrismaClient,
  t: DemoTicketSeed,
  now: number,
  l: DemoLookups,
): Promise<void> {
  // Existing demo tickets are left untouched (and need no lookups, which admin edits may break).
  const seeded = await db.ticket.findUnique({ where: { number: t.number }, select: { id: true } });
  if (seeded) return;

  const label = formatTicketNumber(t.number);
  const userId = (email: string) => must(l.userIdByEmail.get(email), `${label} user`);
  const orgId = must(l.orgIdByKey.get(t.orgKey), `${label} org ${t.orgKey}`);
  const category = must(l.categoryByKey.get(t.categoryKey), `${label} category ${t.categoryKey}`);
  const subtypeId = must(
    l.subtypeIdByCategoryKey.get(`${category.id}:${t.subtypeKey}`),
    `${label} sub-type ${t.subtypeKey}`,
  );
  const siteId = must(l.siteIdByOrgKey.get(`${orgId}:${t.siteKey}`), `${label} site ${t.siteKey}`);
  const tl = buildTicketTimeline(t, now, SLA_POLICIES);

  await db.$transaction(async (tx) => {
    const existing = await tx.ticket.findUnique({
      where: { number: t.number },
      select: { id: true },
    });
    if (existing) return;

    const ticket = await tx.ticket.create({
      data: {
        number: t.number,
        type: t.type,
        subject: t.subject,
        description: must(t.messages[0], `${label} description`).body,
        categoryId: category.id,
        subtypeId,
        priority: t.priority,
        impact: t.impact,
        status: t.status,
        channel: 'PORTAL',
        orgId,
        siteId,
        assetId: t.assetId,
        requesterId: userId(t.requesterEmail),
        assigneeId: t.assigneeEmail ? userId(t.assigneeEmail) : null,
        teamId: category.teamId,
        customFields: { ...t.customFields },
        firstReplyDueAt: tl.firstReplyDueAt,
        resolveDueAt: tl.resolveDueAt,
        firstRepliedAt: tl.firstRepliedAt,
        solvedAt: tl.solvedAt,
        slaAtRiskAt: tl.slaAtRiskAt,
        slaBreached: tl.slaBreached,
        slaBreachedAt: tl.slaBreachedAt,
        slaPausedAt: tl.slaPausedAt,
        p1AckedAt: tl.p1AckedAt,
        p1AckedById: tl.p1AckedByEmail ? userId(tl.p1AckedByEmail) : null,
        lastMessageAt: tl.lastMessageAt,
        createdAt: tl.createdAt,
        updatedAt: tl.updatedAt,
      },
      select: { id: true },
    });

    if (t.tags.length > 0) {
      await tx.ticketTag.createMany({
        data: t.tags.map((key) => ({
          ticketId: ticket.id,
          tagId: must(l.tagIdByKey.get(key), `${label} tag ${key}`),
        })),
        skipDuplicates: true,
      });
    }

    const messageIdByTempId = new Map<string, string>();
    for (const m of tl.messages) {
      const message = await tx.message.upsert({
        where: { ticketId_clientTempId: { ticketId: ticket.id, clientTempId: m.clientTempId } },
        update: {},
        create: {
          ticketId: ticket.id,
          authorId: userId(m.authorEmail),
          type: m.type,
          body: m.body,
          clientTempId: m.clientTempId,
          createdAt: m.createdAt,
        },
        select: { id: true },
      });
      messageIdByTempId.set(m.clientTempId, message.id);
    }

    await tx.ticketEvent.createMany({
      data: tl.events.map((e) => {
        const meta = e.messageClientTempId
          ? { ...e.meta, messageId: must(messageIdByTempId.get(e.messageClientTempId), 'message') }
          : e.meta;
        return {
          ticketId: ticket.id,
          actorId: e.actorEmail ? userId(e.actorEmail) : null,
          type: e.type,
          fromValue: e.fromValue,
          toValue: e.toUserEmail ? userId(e.toUserEmail) : e.toValue,
          ...(meta ? { meta } : {}),
          createdAt: e.createdAt,
        };
      }),
    });
  }, TX_OPTIONS);
}

/**
 * Moves the ticket-number sequence past the demo tickets (next ticket = LG-4834, design nextId).
 * Never moves it backwards: numbers already handed out (even by rolled-back inserts) stay used.
 */
async function advanceTicketSequence(db: PrismaClient): Promise<number> {
  const floor = NEXT_TICKET_NUMBER - 1;
  await db.$queryRaw`
    SELECT setval('"Ticket_number_seq"', GREATEST(
      (SELECT COALESCE(MAX("number"), 0) FROM "Ticket"),
      (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM "Ticket_number_seq"),
      ${floor}::bigint
    ))`;
  const [seq] = await db.$queryRaw<Array<{ last_value: bigint; is_called: boolean }>>`
    SELECT last_value, is_called FROM "Ticket_number_seq"`;
  const { last_value, is_called } = must(seq, 'ticket sequence');
  return is_called ? Number(last_value) + 1 : Number(last_value);
}

async function seedDemo(db: PrismaClient, now: number): Promise<number> {
  await seedDemoPeople(db);
  const lookups = await loadDemoLookups(db);
  for (const t of DEMO_TICKETS) await seedDemoTicket(db, t, now, lookups);
  return advanceTicketSequence(db);
}

// ───────────────────────────── escalation step → operations manager ─────────────────────────────

async function resolveOperationsManagerId(db: PrismaClient, demo: boolean): Promise<string | null> {
  const preferred = [demo ? OPERATIONS_MANAGER_EMAIL : null, process.env.SEED_ADMIN_EMAIL?.trim()]
    .filter((e): e is string => Boolean(e))
    .map(normalizeEmail);
  for (const email of preferred) {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true, role: true, status: true },
    });
    if (user?.role === 'SUPER_ADMIN' && user.status === 'ACTIVE') return user.id;
  }
  const first = await db.user.findFirst({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return first?.id ?? null;
}

async function seedManagerEscalationSteps(db: PrismaClient, demo: boolean): Promise<void> {
  const steps = P1_ESCALATION_STEPS.filter((s) => s.targetsOperationsManager);
  for (const s of steps) {
    const existing = await db.escalationRule.findFirst({
      where: { priority: s.priority, teamId: null, step: s.step },
      select: { id: true },
    });
    if (existing) continue;
    const managerId = await resolveOperationsManagerId(db, demo);
    if (!managerId) {
      console.warn(
        `[seed] ${s.priority} escalation step ${s.step} skipped: no active SUPER_ADMIN yet (set SEED_ADMIN_EMAIL or add it in Admin → Escalation rules)`,
      );
      continue;
    }
    await db.escalationRule.create({
      data: {
        priority: s.priority,
        step: s.step,
        targetType: s.targetType,
        targetUserId: managerId,
        afterMins: s.afterMins,
        channels: [...s.channels],
      },
    });
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = seedOptions();
  const demo = options.demo;
  const db = createPrismaClient({ poolSize: 4 });
  try {
    const configBefore = await countRows(db, 'config');
    const demoBefore = await countRows(db, 'demo');

    await seedConfig(db, options);
    const nextTicket = demo ? await seedDemo(db, startedAt) : null;
    await seedManagerEscalationSteps(db, demo);

    const configAfter = await countRows(db, 'config');
    const demoAfter = await countRows(db, 'demo');
    log(`config: ${formatCounts(configBefore, configAfter)}`);
    if (demo) {
      log(`demo: ${formatCounts(demoBefore, demoAfter)}`);
      log(`next ticket number: ${formatTicketNumber(must(nextTicket, 'next ticket'))}`);
    } else {
      log(
        'demo: skipped (needs SEED_DEMO_DATA=true and NODE_ENV=development or test; `pnpm db:seed` defaults to development)',
      );
    }
    log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Prisma validation errors echo query arguments (emails, hashes), so production logs only get the
 * error class, code and final message line; development keeps the stack for debugging demo data.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const rawCode = (error as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? `[${rawCode}] ` : '';
  if (isNonProductionEnv()) return `${code}${error.stack ?? error.message}`;
  const lastLine = error.message
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return `${code}${error.name}: ${lastLine ?? ''}`;
}

main().catch((error: unknown) => {
  console.error(`[seed] failed: ${describeError(error)}`);
  process.exitCode = 1;
});
