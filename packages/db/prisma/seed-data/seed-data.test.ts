// Data-integrity checks for the seed (no database needed).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isStaffEmail } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import {
  CustomFieldType,
  EscalationChannel,
  Impact,
  Priority,
  Role,
  TicketStatus,
  TicketType,
} from '../../src/generated/prisma/enums.ts';
import { CATEGORIES } from './categories.ts';
import { CUSTOM_FIELDS } from './custom-fields.ts';
import {
  CLIENT_EMAILS,
  DEMO_CLIENTS,
  DEMO_ORGS,
  DEMO_STAFF,
  DEMO_TEAM_STAFFING,
  DEMO_TICKETS,
  NEXT_TICKET_NUMBER,
  OPERATIONS_MANAGER_EMAIL,
} from './demo.ts';
import { EMAIL_TEMPLATES } from './email-templates.ts';
import { HELP_ARTICLES } from './help-articles.ts';
import { HOLIDAYS } from './holidays.ts';
import { MACRO_VARIABLES, MACROS } from './macros.ts';
import {
  APP_SETTINGS,
  BUSINESS_DAY_MINS,
  BUSINESS_HOURS,
  P1_ESCALATION_STEPS,
  SLA_POLICIES,
} from './sla.ts';
import { TAGS } from './tags.ts';
import { TEAMS } from './teams.ts';
import { buildTicketTimeline, seedClientTempId } from './ticket-timeline.ts';
import { isoDate, MINUTE_MS, slugify } from './util.ts';

const values = <T extends Record<string, string>>(e: T) => Object.values(e) as string[];

function expectUnique(items: readonly string[], what: string) {
  const dupes = items.filter((v, i) => items.indexOf(v) !== i);
  expect(dupes, `duplicate ${what}`).toEqual([]);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] ?? '');
}

const arabic = /[\u0600-\u06ff]/;

// ───────────────────────────── teams & categories ─────────────────────────────

describe('teams', () => {
  it('has the 10 design teams with unique keys and EN + AR names', () => {
    expect(TEAMS.map((t) => t.key)).toEqual([
      'soc',
      'noc',
      'elv',
      'dcops',
      'itsd',
      'bms',
      'av',
      'sw',
      'am',
      'triage',
    ]);
    expectUnique(
      TEAMS.map((t) => t.key),
      'team key',
    );
    for (const t of TEAMS) {
      expect(t.nameEn.trim(), t.key).not.toBe('');
      expect(t.nameAr, t.key).toMatch(arabic);
      expect(t.emails.length, t.key).toBeGreaterThan(0);
      for (const email of t.emails) expect(isStaffEmail(email), email).toBe(true);
    }
  });
});

describe('categories and sub-types', () => {
  const teamKeys = new Set(TEAMS.map((t) => t.key));

  it('has the 12 design categories with unique keys', () => {
    expect(CATEGORIES.map((c) => c.key)).toEqual([
      'cyber',
      'network',
      'dc',
      'cloud',
      'cctv',
      'access',
      'life',
      'bms',
      'av',
      'software',
      'service',
      'other',
    ]);
    expectUnique(
      CATEGORIES.map((c) => c.key),
      'category key',
    );
  });

  it.each(CATEGORIES.map((c) => [c.key, c] as const))(
    '%s routes to an existing team and is fully labelled',
    (_key, c) => {
      expect(teamKeys.has(c.teamKey)).toBe(true);
      expect(c.labelEn.trim()).not.toBe('');
      expect(c.labelAr).toMatch(arabic);
      expect(c.assetPlaceholder.trim()).not.toBe('');
      expect(c.subtypes.length).toBeGreaterThan(0);
    },
  );

  it('every sub-type has a slug key, EN + AR labels and a valid default priority', () => {
    for (const c of CATEGORIES) {
      expectUnique(
        c.subtypes.map((s) => s.key),
        `${c.key} sub-type key`,
      );
      for (const s of c.subtypes) {
        const where = `${c.key}/${s.key}`;
        expect(s.key, where).toBe(slugify(s.labelEn));
        expect(s.labelEn.trim(), where).not.toBe('');
        expect(s.labelAr.trim(), where).not.toBe('');
        expect(s.labelAr, where).toMatch(arabic);
        expect(values(Priority), where).toContain(s.defaultPriority);
      }
    }
  });

  it('matches the spec §13 sub-type counts and routing', () => {
    const summary = Object.fromEntries(
      CATEGORIES.map((c) => [c.key, `${c.teamKey}:${c.subtypes.length}`]),
    );
    expect(summary).toEqual({
      cyber: 'soc:8',
      network: 'noc:7',
      dc: 'dcops:7',
      cloud: 'itsd:6',
      cctv: 'elv:6',
      access: 'elv:6',
      life: 'elv:5',
      bms: 'bms:5',
      av: 'av:5',
      software: 'sw:5',
      service: 'am:7',
      other: 'triage:1',
    });
    const service = CATEGORIES.find((c) => c.key === 'service');
    expect(service?.subtypes.every((s) => s.defaultPriority === 'P4')).toBe(true);
  });

  it('uses lucide-react icon names that exist (canonical, not deprecated aliases)', () => {
    const iconMap = path.resolve(
      import.meta.dirname,
      '../../../../apps/web/node_modules/lucide-react/dist/esm/dynamicIconImports.mjs',
    );
    expect(existsSync(iconMap), `lucide-react not installed at ${iconMap}`).toBe(true);
    const source = readFileSync(iconMap, 'utf8');
    for (const c of CATEGORIES) {
      expect(c.icon, c.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      // Canonical entries import a module of the same name: "cctv": () => import('./icons/cctv.mjs')
      expect(source, `${c.key}: ${c.icon}`).toContain(
        `"${c.icon}": () => import('./icons/${c.icon}.mjs')`,
      );
    }
  });
});

describe('custom fields', () => {
  it('have unique keys, valid types, EN + AR labels and placeholders', () => {
    expectUnique(
      CUSTOM_FIELDS.map((f) => f.key),
      'custom field key',
    );
    for (const f of CUSTOM_FIELDS) {
      expect(values(CustomFieldType), f.key).toContain(f.type);
      expect(f.labelEn.trim(), f.key).not.toBe('');
      expect(f.labelAr, f.key).toMatch(arabic);
      expect(f.placeholderEn.trim(), f.key).not.toBe('');
      expect(f.placeholderAr, f.key).toMatch(arabic);
      expect(f.required, f.key).toBe(false);
    }
  });

  it('link only to existing categories, as the spec assigns them', () => {
    const categoryKeys = new Set(CATEGORIES.map((c) => c.key));
    for (const f of CUSTOM_FIELDS) {
      expect(f.categoryKeys.length, f.key).toBeGreaterThan(0);
      for (const key of f.categoryKeys)
        expect(categoryKeys.has(key), `${f.key} → ${key}`).toBe(true);
    }
    expect(
      Object.fromEntries(CUSTOM_FIELDS.map((f) => [f.key, [f.type, ...f.categoryKeys]])),
    ).toEqual({
      camera_id: ['ASSET_ID', 'cctv'],
      door_reader: ['TEXT', 'access'],
      panel_zone: ['TEXT', 'life'],
      server_hostname: ['TEXT', 'dc'],
      room_name: ['TEXT', 'av'],
    });
  });
});

// ───────────────────────────── SLA, calendar, escalation ─────────────────────────────

describe('SLA policies', () => {
  it('match the spec (minutes)', () => {
    const byPriority = Object.fromEntries(
      SLA_POLICIES.map((p) => [
        p.priority,
        [p.firstReplyMins, p.resolveMins, p.businessHoursOnly, p.atRiskPercent],
      ]),
    );
    expect(byPriority).toEqual({
      P1: [15, 240, false, 75],
      P2: [60, 480, false, 75],
      P3: [240, 1080, true, 75],
      P4: [540, 2700, true, 75],
    });
    expect(BUSINESS_DAY_MINS).toBe(9 * 60);
  });

  it('cover every priority exactly once', () => {
    expect(SLA_POLICIES.map((p) => p.priority).sort()).toEqual(values(Priority).sort());
  });
});

describe('business hours, holidays and settings', () => {
  it('open Sunday–Thursday 07:30–16:30, closed Friday and Saturday', () => {
    expect(BUSINESS_HOURS.map((h) => h.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const h of BUSINESS_HOURS) {
      expect(h.isOpen, `weekday ${h.weekday}`).toBe(h.weekday <= 4);
      expect([h.open, h.close]).toEqual(['07:30', '16:30']);
    }
  });

  it('holidays are unique dates with EN + AR names; Eid dates are marked as estimates', () => {
    expectUnique(
      HOLIDAYS.map((h) => isoDate(h.date)),
      'holiday date',
    );
    for (const h of HOLIDAYS) {
      expect(h.date.getUTCHours() + h.date.getUTCMinutes()).toBe(0);
      expect(h.nameAr).toMatch(arabic);
      if (h.name.startsWith('Eid')) {
        expect(h.name).toContain('(estimated)');
        expect(h.nameAr).toContain('(تقديري)');
      }
    }
    const fixed = HOLIDAYS.filter((h) => !h.name.startsWith('Eid')).map(
      (h) => `${isoDate(h.date)} ${h.name}`,
    );
    expect(fixed).toEqual([
      '2026-02-10 National Sports Day',
      '2026-12-18 Qatar National Day',
      '2027-02-09 National Sports Day',
      '2027-12-18 Qatar National Day',
      '2028-02-08 National Sports Day',
      '2028-12-18 Qatar National Day',
    ]);
    for (const year of [2026, 2027, 2028]) {
      for (const eid of ['Eid al-Fitr', 'Eid al-Adha']) {
        const days = HOLIDAYS.filter(
          (h) => h.name.startsWith(eid) && h.date.getUTCFullYear() === year,
        );
        expect(days.length, `${eid} ${year}`).toBe(3);
      }
    }
  });

  it('National Sports Day falls on the second Tuesday of February', () => {
    for (const h of HOLIDAYS.filter((x) => x.name === 'National Sports Day')) {
      expect(h.date.getUTCDay()).toBe(2);
      expect(h.date.getUTCMonth()).toBe(1);
      expect(h.date.getUTCDate()).toBeGreaterThanOrEqual(8);
      expect(h.date.getUTCDate()).toBeLessThanOrEqual(14);
    }
  });

  it('app settings', () => {
    expect(Object.fromEntries(APP_SETTINGS.map((s) => [s.key, s.value]))).toEqual({
      'business.timezone': 'Asia/Qatar',
      'tickets.autoCloseDays': 5,
      'support.socPhone': '+974 4000 0000',
      'notifications.p4DigestTime': '07:30',
      'tickets.securityCategoryKey': 'cyber',
    });
  });

  it('phase 3 settings are usable: the digest time is "HH:mm", the security category exists', () => {
    const value = (key: string) => APP_SETTINGS.find((s) => s.key === key)?.value;
    expect(value('notifications.p4DigestTime')).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(CATEGORIES.map((c) => c.key)).toContain(value('tickets.securityCategoryKey'));
  });

  it('2028 Eid estimates follow 2027 by one Hijri year (354–355 days)', () => {
    const first = (name: string, year: number) =>
      HOLIDAYS.find((h) => h.name.startsWith(name) && h.date.getUTCFullYear() === year)!.date;
    for (const eid of ['Eid al-Fitr', 'Eid al-Adha']) {
      const days = (first(eid, 2028).getTime() - first(eid, 2027).getTime()) / 86_400_000;
      expect(days, eid).toBeGreaterThanOrEqual(354);
      expect(days, eid).toBeLessThanOrEqual(355);
    }
  });
});

describe('P1 escalation chain', () => {
  it('on-call → team lead → operations manager', () => {
    expect(
      P1_ESCALATION_STEPS.map((s) => [
        s.priority,
        s.step,
        s.targetType,
        s.targetRole,
        s.targetsOperationsManager,
        s.afterMins,
        [...s.channels],
      ]),
    ).toEqual([
      ['P1', 1, 'ON_CALL', null, false, 0, ['EMAIL', 'TEAMS', 'SMS']],
      ['P1', 2, 'ROLE', 'TEAM_LEAD', false, 5, ['EMAIL', 'TEAMS', 'SMS']],
      ['P1', 3, 'USER', null, true, 15, ['EMAIL', 'SMS']],
    ]);
    for (const s of P1_ESCALATION_STEPS) {
      for (const c of s.channels) expect(values(EscalationChannel)).toContain(c);
    }
  });

  it('the operations manager is the demo SUPER_ADMIN', () => {
    expect(DEMO_STAFF.find((u) => u.email === OPERATIONS_MANAGER_EMAIL)?.role).toBe('SUPER_ADMIN');
  });
});

// ───────────────────────────── content ─────────────────────────────

describe('macros, email templates, help articles, tags', () => {
  it('macros are global, bilingual and only use known placeholders', () => {
    expectUnique(
      MACROS.map((m) => m.key),
      'macro key',
    );
    expect(MACROS.map((m) => m.titleEn)).toEqual([
      'Request photos/video',
      'Engineer dispatched',
      'Awaiting client access',
      'Escalate to SOC',
    ]);
    for (const m of MACROS) {
      expect(m.titleAr, m.key).toMatch(arabic);
      expect(m.bodyAr, m.key).toMatch(arabic);
      for (const v of [...placeholders(m.bodyEn), ...placeholders(m.bodyAr)]) {
        expect(MACRO_VARIABLES as readonly string[], `${m.key}: ${v}`).toContain(v);
      }
    }
    expect(MACROS.find((m) => m.key === 'awaiting-client-access')?.setStatus).toBe('PENDING');
    expect(MACROS.filter((m) => m.setStatus !== null)).toHaveLength(1);
  });

  it('email templates cover every notification and declare every placeholder they use', () => {
    expect(EMAIL_TEMPLATES.map((t) => t.key)).toEqual([
      'TICKET_CREATED_CLIENT',
      'TICKET_CREATED_TEAM',
      'AGENT_REPLY_CLIENT',
      'CLIENT_REPLY_ASSIGNEE',
      'SLA_AT_RISK',
      'SLA_BREACHED',
      'P1_ALERT',
      'P1_ESCALATION',
      'P4_DAILY_DIGEST',
      'PASSWORD_RESET',
      'EMAIL_VERIFICATION',
      'GOOGLE_LINKED',
    ]);
    for (const t of EMAIL_TEMPLATES) {
      expectUnique([...t.variables], `${t.key} variable`);
      for (const v of t.variables) expect(v, t.key).toMatch(/^[a-z][A-Za-z0-9]*$/);
      const en = new Set([...placeholders(t.subjectEn), ...placeholders(t.bodyEn)]);
      const ar = new Set([...placeholders(t.subjectAr), ...placeholders(t.bodyAr)]);
      // Every placeholder is declared, and both languages use the same set.
      for (const v of en) expect(t.variables, `${t.key}: ${v}`).toContain(v);
      expect([...ar].sort(), t.key).toEqual([...en].sort());
      // Every declared variable is actually used.
      for (const v of t.variables) expect(en.has(v), `${t.key}: unused ${v}`).toBe(true);
      expect(t.subjectAr + t.bodyAr, t.key).toMatch(arabic);
    }
    expect(EMAIL_TEMPLATES.find((t) => t.key === 'PASSWORD_RESET')?.variables).toEqual([
      'name',
      'resetUrl',
      'expiresMinutes',
    ]);
    // Same names as the API passes (and as the built-in default in @loons/emails).
    expect(EMAIL_TEMPLATES.find((t) => t.key === 'EMAIL_VERIFICATION')?.variables).toEqual([
      'name',
      'verifyUrl',
      'expiresHours',
    ]);
    // UI-RR-2: Arabic text uses the Arabic product name (مكتب دعم لونز), never the Latin one.
    for (const t of EMAIL_TEMPLATES) {
      expect(t.subjectAr, t.key).not.toContain('Loons Help Desk');
      expect(t.bodyAr, t.key).not.toContain('Loons Help Desk');
    }
    expect(EMAIL_TEMPLATES.find((t) => t.key === 'GOOGLE_LINKED')?.variables).toEqual([
      'name',
      'signInUrl',
    ]);
  });

  it('help articles are the 5 design articles in EN + AR', () => {
    expect(HELP_ARTICLES).toHaveLength(5);
    expectUnique(
      HELP_ARTICLES.map((a) => a.key),
      'article key',
    );
    for (const a of HELP_ARTICLES) {
      expect(a.titleEn.trim(), a.key).not.toBe('');
      expect(a.bodyEn.trim(), a.key).not.toBe('');
      expect(a.titleAr, a.key).toMatch(arabic);
      expect(a.bodyAr, a.key).toMatch(arabic);
    }
  });

  it('tags', () => {
    expect(TAGS.map((t) => t.key)).toEqual([
      'firewall',
      'brute-force',
      'nvr',
      'turnstile',
      'fibre',
      'ppm',
    ]);
  });
});

// ───────────────────────────── demo data ─────────────────────────────

describe('demo organisations and users', () => {
  const staffEmails = new Set(DEMO_STAFF.map((u) => u.email));

  it('users have unique lower-case emails; staff on the staff domain, clients not', () => {
    const all = [...DEMO_STAFF, ...DEMO_CLIENTS];
    expectUnique(
      all.map((u) => u.email),
      'user email',
    );
    for (const u of all) expect(u.email).toBe(u.email.toLowerCase());
    for (const s of DEMO_STAFF) {
      expect(isStaffEmail(s.email), s.email).toBe(true);
      expect(values(Role)).toContain(s.role);
      expect(s.role).not.toBe('CLIENT');
      expect(s.phone).toMatch(/^\+974 \d{4} \d{4}$/);
    }
    for (const c of DEMO_CLIENTS) {
      expect(isStaffEmail(c.email), c.email).toBe(false);
      expect(c.role).toBe('CLIENT');
    }
    expect(DEMO_STAFF.filter((s) => s.role === 'SUPER_ADMIN')).toHaveLength(1);
  });

  it('every team has members, a lead and an on-call member', () => {
    const staffed = DEMO_TEAM_STAFFING.map((s) => s.teamKey).sort();
    expect(staffed).toEqual(TEAMS.map((t) => t.key).sort());
    for (const s of DEMO_TEAM_STAFFING) {
      expect(s.members.length, s.teamKey).toBeGreaterThan(0);
      expectUnique(
        s.members.map((m) => m.email),
        `${s.teamKey} member`,
      );
      for (const m of s.members) expect(staffEmails.has(m.email), m.email).toBe(true);
      expect(
        s.members.some((m) => m.role === 'LEAD'),
        `${s.teamKey} lead`,
      ).toBe(true);
      expect(
        s.members.map((m) => m.email),
        `${s.teamKey} on-call`,
      ).toContain(s.onCallEmail);
      for (const m of s.members.filter((x) => x.role === 'LEAD')) {
        expect(DEMO_STAFF.find((u) => u.email === m.email)?.role).toBe('TEAM_LEAD');
      }
    }
  });

  it('organisations have unique keys, sites, domains, and staff account managers', () => {
    expectUnique(
      DEMO_ORGS.map((o) => o.key),
      'org key',
    );
    for (const o of DEMO_ORGS) {
      expect(o.nameAr, o.key).toMatch(arabic);
      expect(staffEmails.has(o.accountManagerEmail), o.key).toBe(true);
      expect(o.contractType === 'AMC', o.key).toBe(o.amcExpiry !== null);
      expectUnique(
        o.sites.map((s) => s.key),
        `${o.key} site key`,
      );
      for (const s of o.sites) expect(s.nameAr, `${o.key}/${s.key}`).toMatch(arabic);
      for (const d of o.emailDomains) expect(d).toBe(d.toLowerCase());
    }
    expect(DEMO_ORGS.find((o) => o.key === 'hmc')?.sites.map((s) => s.name)).toContain(
      'HMC – All sites',
    );
  });

  it('each client belongs to the org whose email domain matches', () => {
    for (const c of DEMO_CLIENTS) {
      const org = DEMO_ORGS.find((o) => o.key === c.orgKey);
      expect(org, c.email).toBeDefined();
      expect(org?.emailDomains).toContain(c.email.split('@')[1]);
    }
  });
});

describe('demo tickets', () => {
  const now = Date.UTC(2026, 8, 23, 9, 0, 0);
  const categoryByKey = new Map(CATEGORIES.map((c) => [c.key, c]));
  const fieldByKey = new Map(CUSTOM_FIELDS.map((f) => [f.key, f]));
  const clientByEmail = new Map(DEMO_CLIENTS.map((c) => [c.email, c]));
  const staffByEmail = new Map(DEMO_STAFF.map((s) => [s.email, s]));
  const teamsByStaff = new Map<string, string[]>();
  for (const s of DEMO_TEAM_STAFFING) {
    for (const m of s.members)
      teamsByStaff.set(m.email, [...(teamsByStaff.get(m.email) ?? []), s.teamKey]);
  }

  it('are the 7 design tickets, below the next ticket number', () => {
    expect(DEMO_TICKETS.map((t) => t.number)).toEqual([4817, 4771, 4821, 4809, 4790, 4829, 4752]);
    expectUnique(
      DEMO_TICKETS.map((t) => String(t.number)),
      'ticket number',
    );
    for (const t of DEMO_TICKETS) expect(t.number).toBeLessThan(NEXT_TICKET_NUMBER);
    expect(NEXT_TICKET_NUMBER).toBe(4834);
    expect(Object.values(CLIENT_EMAILS).sort()).toEqual(DEMO_CLIENTS.map((c) => c.email).sort());
  });

  it.each(DEMO_TICKETS.map((t) => [t.number, t] as const))(
    'LG-%i references valid config and people',
    (_n, t) => {
      const category = categoryByKey.get(t.categoryKey);
      expect(category).toBeDefined();
      expect(category?.subtypes.map((s) => s.key)).toContain(t.subtypeKey);
      expect(values(TicketType)).toContain(t.type);
      expect(values(Priority)).toContain(t.priority);
      expect(values(Impact)).toContain(t.impact);
      expect(values(TicketStatus)).toContain(t.status);
      if (t.type === 'SECURITY_INCIDENT') expect(t.categoryKey).toBe('cyber');

      const requester = clientByEmail.get(t.requesterEmail);
      expect(requester?.orgKey).toBe(t.orgKey);
      const org = DEMO_ORGS.find((o) => o.key === t.orgKey);
      expect(org?.sites.map((s) => s.key)).toContain(t.siteKey);

      if (t.assigneeEmail) {
        expect(staffByEmail.has(t.assigneeEmail)).toBe(true);
        expect(teamsByStaff.get(t.assigneeEmail)).toContain(category?.teamKey);
      }
      for (const tag of t.tags) expect(TAGS.map((x) => x.key)).toContain(tag);

      // Custom field values only for fields linked to the ticket's category.
      for (const key of Object.keys(t.customFields)) {
        expect(fieldByKey.get(key)?.categoryKeys, `${key}`).toContain(t.categoryKey);
      }

      expect(t.messages[0]?.kind).toBe('customer');
      expect(t.messages[0]?.agoMin).toBe(t.createdAgoMin);
      for (const m of t.messages) {
        if (m.kind !== 'customer') expect(staffByEmail.has(m.authorEmail ?? '')).toBe(true);
        expect(m.agoMin).toBeLessThanOrEqual(t.createdAgoMin);
      }
      for (const a of t.activity) {
        expect(staffByEmail.has(a.byEmail)).toBe(true);
        expect(a.agoMin).toBeLessThanOrEqual(t.createdAgoMin);
      }
      if (t.activity.some((a) => a.type === 'P1_ACKNOWLEDGED')) expect(t.priority).toBe('P1');
    },
  );

  it.each(DEMO_TICKETS.map((t) => [t.number, t] as const))(
    'LG-%i timeline is consistent with the ticket state',
    (_n, t) => {
      const tl = buildTicketTimeline(t, now, SLA_POLICIES);
      const policy = SLA_POLICIES.find((p) => p.priority === t.priority);

      expect(tl.createdAt.getTime()).toBe(now - t.createdAgoMin * MINUTE_MS);
      expect(tl.resolveDueAt.getTime() - tl.createdAt.getTime()).toBe(
        (policy?.resolveMins ?? 0) * MINUTE_MS,
      );
      if (t.firstReplyDueInMin !== null) {
        expect(tl.firstReplyDueAt.getTime()).toBe(now + t.firstReplyDueInMin * MINUTE_MS);
      }

      // Messages: deterministic temp ids, design kinds → message types.
      expect(tl.messages.map((m) => m.clientTempId)).toEqual(
        t.messages.map((_m, i) => seedClientTempId(t.number, i)),
      );
      expect(tl.messages[0]?.clientTempId).toBe(`seed:LG-${t.number}:1`);
      t.messages.forEach((m, i) => {
        expect(tl.messages[i]?.type).toBe(m.kind === 'note' ? 'INTERNAL' : 'PUBLIC');
        expect(tl.messages[i]?.authorEmail).toBe(
          m.kind === 'customer' ? t.requesterEmail : m.authorEmail,
        );
      });

      // Events are chronological, start with CREATED and never precede the ticket.
      expect(tl.events[0]?.type).toBe('CREATED');
      const times = tl.events.map((e) => e.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(Math.min(...times)).toBe(tl.createdAt.getTime());
      expect(tl.updatedAt.getTime()).toBeLessThanOrEqual(now);

      // Final status / assignee match the last recorded change.
      const statusEvents = tl.events.filter((e) => e.type === 'STATUS_CHANGED');
      expect(statusEvents.at(-1)?.toValue ?? 'NEW').toBe(t.status);
      const assigneeEvents = tl.events.filter((e) => e.type === 'ASSIGNEE_CHANGED');
      expect(assigneeEvents.at(-1)?.toUserEmail ?? null).toBe(t.assigneeEmail);
      expect(tl.events.some((e) => e.type === 'TAGS_CHANGED')).toBe(t.tags.length > 0);

      // First reply = first agent PUBLIC message.
      const firstAgent = t.messages.findIndex((m) => m.kind === 'agent');
      expect(tl.firstRepliedAt?.getTime() ?? null).toBe(
        firstAgent === -1 ? null : (tl.messages[firstAgent]?.createdAt.getTime() ?? null),
      );
      expect(tl.events.filter((e) => e.type === 'FIRST_REPLY')).toHaveLength(
        firstAgent === -1 ? 0 : 1,
      );

      expect(tl.solvedAt !== null).toBe(t.status === 'SOLVED');
      expect(tl.slaPausedAt !== null).toBe(t.status === 'PENDING');
      expect(tl.p1AckedAt !== null).toBe(tl.p1AckedByEmail !== null);
      expect(tl.slaBreached).toBe(tl.events.some((e) => e.type === 'SLA_BREACHED'));
      expect(tl.lastMessageAt?.getTime()).toBe(
        Math.max(...tl.messages.map((m) => m.createdAt.getTime())),
      );
    },
  );

  it('matches the design: acknowledged P1s, the overdue ticket and first replies', () => {
    const timelines = new Map(
      DEMO_TICKETS.map((t) => [t.number, buildTicketTimeline(t, now, SLA_POLICIES)]),
    );
    expect(timelines.get(4817)?.p1AckedByEmail).toBe('maya.ruiz@loonsgroup.com');
    expect(timelines.get(4809)?.p1AckedByEmail).toBe('theo.kim@loonsgroup.com');
    expect([...timelines].filter(([, tl]) => tl.p1AckedAt !== null).map(([n]) => n)).toEqual([
      4817, 4809,
    ]);
    expect([...timelines].filter(([, tl]) => tl.slaBreached).map(([n]) => n)).toEqual([4771]);
    // Only the overdue ticket is currently flagged at risk (LG-4809 was at risk before its reply).
    expect([...timelines].filter(([, tl]) => tl.slaAtRiskAt !== null).map(([n]) => n)).toEqual([
      4771,
    ]);
    expect([...timelines].filter(([, tl]) => tl.firstRepliedAt !== null).map(([n]) => n)).toEqual([
      4809, 4752,
    ]);
    const messageCount = DEMO_TICKETS.reduce((sum, t) => sum + t.messages.length, 0);
    expect(messageCount).toBe(10);
  });
});
