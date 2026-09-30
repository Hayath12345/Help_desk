import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { storedCustomFieldOptionSchema } from '../tickets.ts';
import * as admin from './index.ts';
import {
  adminKeySchema,
  createCategorySchema,
  createCustomFieldSchema,
  createEscalationRuleSchema,
  emailDomainSchema,
  labelArSchema,
  labelEnSchema,
  optionalText,
  reorderBodySchema,
  slugifyKey,
  staffNameSchema,
  teamsWebhookUrlSchema,
  unknownMacroVariables,
  updateBusinessHoursSchema,
  updateCategorySchema,
  updateEscalationRuleSchema,
  updateGeneralSettingsSchema,
} from './index.ts';

const T = '2026-09-29T10:00:00.000Z';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const messages = (r: { success: boolean; error?: z.ZodError }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('keys (E4)', () => {
  it('slugifies the English label', () => {
    expect(slugifyKey('Access Control & CCTV')).toBe('access-control-cctv');
    expect(slugifyKey('  Café Wi-Fi!  ')).toBe('cafe-wi-fi');
    expect(slugifyKey('Camera ID', { separator: '_' })).toBe('camera_id');
    expect(slugifyKey('التحكم في الدخول')).toBe('');
    expect(slugifyKey('x')).toBe('');
    const long = slugifyKey('Preventive maintenance for the building management system', {
      maxLength: 30,
    });
    expect(long).toBe('preventive-maintenance-for');
    expect(adminKeySchema.safeParse(long).success).toBe(true);
  });

  it('accepts only lower-case key groups joined by - or _', () => {
    for (const ok of ['cyber', 'camera_id', 'request-photos-video', 'p1'])
      expect(adminKeySchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['A', 'Cyber', 'two  words', '-lead', 'trail_', 'a--b', 'x'])
      expect(adminKeySchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('common fragments', () => {
  it('optional text: blank means none, text is cleaned and trimmed', () => {
    const schema = optionalText(10);
    expect(schema.parse('')).toBe(null);
    expect(schema.parse('   ')).toBe(null);
    expect(schema.parse(null)).toBe(null);
    expect(schema.parse(' a\u0000b ')).toBe('ab');
    expect(schema.safeParse('x'.repeat(11)).success).toBe(false);
  });

  it('labels drop bidi embedding, override and isolate controls (no reversed names)', () => {
    expect(labelEnSchema.parse('Bidi ‮gnp.exe')).toBe('Bidi gnp.exe');
    expect(labelEnSchema.parse('⁦Team⁩ ‪one‬')).toBe('Team one');
    expect(labelArSchema.parse(' ‫فريق الشبكات‬ ')).toBe('فريق الشبكات');
    expect(optionalText(40).parse('‭placeholder‮')).toBe('placeholder');
    // Arabic text and ordinary marks are kept.
    expect(labelArSchema.parse('مركز العمليات — SOC')).toBe('مركز العمليات — SOC');
    expect(labelEnSchema.safeParse('‮').success).toBe(false);
  });

  it('labels drop invisible format characters; a label with nothing visible is blank', () => {
    // Zero-width space, LRM / RLM, Arabic letter mark, word joiner, BOM, C1 controls, and a lone
    // ZWJ / ZWNJ: "required" must mean something visible (review shared-db-3).
    for (const blank of [
      '\u200b',
      '\u200e',
      '\u200f',
      '\u061c',
      '\u2060',
      '\ufeff',
      '\u0085',
      '\u200d',
      '\u200c\u200b ',
      ' \u200e\u202e ',
    ]) {
      const result = labelEnSchema.safeParse(blank);
      expect(messages(result), JSON.stringify(blank)).toEqual(['validation.required']);
      expect(labelArSchema.parse(blank), JSON.stringify(blank)).toBe('');
      expect(optionalText(40).parse(blank), JSON.stringify(blank)).toBe(null);
    }
    expect(labelEnSchema.parse('Door\u200b panel\u200e')).toBe('Door panel');
    expect(labelEnSchema.parse('\u0085Lobby\u2060')).toBe('Lobby');
    // ZWNJ / ZWJ between visible characters are kept (Persian / Arabic shaping, emoji).
    expect(labelArSchema.parse('می\u200cخواهم')).toBe('می\u200cخواهم');
    expect(labelEnSchema.parse('Ops \u{1f468}\u200d\u{1f4bb}')).toBe(
      'Ops \u{1f468}\u200d\u{1f4bb}',
    );
  });

  it('staff names follow the label rules: no bidi controls, nothing invisible', () => {
    expect(staffNameSchema.parse('\u202eabc')).toBe('abc');
    expect(staffNameSchema.parse('\u2066Sara\u2069 Ali\u200b')).toBe('Sara Ali');
    expect(messages(staffNameSchema.safeParse('\u200b\u200e\u200f'))).toEqual([
      'validation.nameMin',
    ]);
    expect(staffNameSchema.parse('سارة علي')).toBe('سارة علي');
  });

  it('reorder: ids must be a permutation of expectedIds', () => {
    const ok = reorderBodySchema.safeParse({ expectedIds: [ID(1), ID(2)], ids: [ID(2), ID(1)] });
    expect(ok.success).toBe(true);
    const missing = reorderBodySchema.safeParse({ expectedIds: [ID(1), ID(2)], ids: [ID(2)] });
    expect(messages(missing)).toContain('validation.reorderMismatch');
    const other = reorderBodySchema.safeParse({ expectedIds: [ID(1)], ids: [ID(3)] });
    expect(messages(other)).toContain('validation.reorderMismatch');
    const dup = reorderBodySchema.safeParse({ expectedIds: [ID(1), ID(1)], ids: [ID(1), ID(1)] });
    expect(messages(dup)).toContain('validation.duplicateValue');
  });

  it('updates must change something besides expectedUpdatedAt', () => {
    expect(messages(updateCategorySchema.safeParse({ expectedUpdatedAt: T }))).toContain(
      'validation.nothingToChange',
    );
    expect(updateCategorySchema.safeParse({ expectedUpdatedAt: T, labelAr: '' }).success).toBe(
      true,
    );
    expect(
      messages(updateGeneralSettingsSchema.safeParse({ expectedUpdatedAt: null, values: {} })),
    ).toContain('validation.nothingToChange');
  });
});

describe('section rules', () => {
  it('a category is created with its first sub-type', () => {
    const base = { labelEn: 'Printers', teamId: ID(1) };
    expect(createCategorySchema.safeParse(base).success).toBe(false);
    const parsed = createCategorySchema.parse({ ...base, firstSubtype: { labelEn: 'Jam' } });
    expect(parsed.firstSubtype).toEqual({ labelEn: 'Jam', labelAr: '', defaultPriority: 'P3' });
    expect(parsed.icon).toBe('circle-question-mark');
    expect(parsed.assetPlaceholder).toBe(null);
  });

  it('custom fields: options for dropdowns only, unique values, one active at least', () => {
    const opt = (value: string, isActive = true) => ({ value, labelEn: value, isActive });
    const field = (type: string, options: unknown[]) =>
      createCustomFieldSchema.safeParse({ labelEn: 'F', type, options });
    expect(field('DROPDOWN', [opt('a'), opt('b')]).success).toBe(true);
    expect(messages(field('DROPDOWN', []))).toContain('validation.optionsRequired');
    expect(messages(field('MULTI_SELECT', [opt('a', false)]))).toContain(
      'validation.optionsRequired',
    );
    expect(messages(field('TEXT', [opt('a')]))).toContain('validation.optionsNotAllowed');
    expect(messages(field('DROPDOWN', [opt('a'), opt('a')]))).toContain(
      'validation.duplicateValue',
    );
  });

  it('stored options without isActive are active (rows written before Phase 4)', () => {
    expect(storedCustomFieldOptionSchema.parse({ value: 'a', labelEn: 'A', labelAr: '' })).toEqual({
      value: 'a',
      labelEn: 'A',
      labelAr: '',
      isActive: true,
    });
  });

  it('business hours: seven distinct days, open < close, at least one open day', () => {
    const day = (weekday: number, isOpen = true, open = '07:30', close = '16:30') => ({
      weekday,
      isOpen,
      open,
      close,
      expectedUpdatedAt: T,
    });
    const week = [0, 1, 2, 3, 4, 5, 6].map((d) => day(d, d <= 4));
    expect(updateBusinessHoursSchema.safeParse({ days: week }).success).toBe(true);
    const inverted = week.map((d) => (d.weekday === 1 ? day(1, true, '17:00', '08:00') : d));
    expect(messages(updateBusinessHoursSchema.safeParse({ days: inverted }))).toContain(
      'validation.openBeforeClose',
    );
    const closed = week.map((d) => ({ ...d, isOpen: false }));
    expect(messages(updateBusinessHoursSchema.safeParse({ days: closed }))).toContain(
      'validation.oneOpenDay',
    );
    const twice = week.map((d) => (d.weekday === 6 ? day(0) : d));
    expect(messages(updateBusinessHoursSchema.safeParse({ days: twice }))).toContain(
      'validation.duplicateValue',
    );
    expect(
      updateBusinessHoursSchema.safeParse({ days: week.map((d) => ({ ...d, open: '7:30' })) })
        .success,
    ).toBe(false);
  });

  it('escalation targets: ROLE ⇒ role, USER ⇒ user, ON_CALL ⇒ neither', () => {
    const rule = (over: Record<string, unknown>) =>
      createEscalationRuleSchema.safeParse({
        teamId: null,
        step: 1,
        afterMins: 0,
        channels: ['EMAIL'],
        ...over,
      });
    expect(rule({ targetType: 'ON_CALL' }).success).toBe(true);
    expect(rule({ targetType: 'ROLE', targetRole: 'TEAM_LEAD' }).success).toBe(true);
    expect(rule({ targetType: 'USER', targetUserId: ID(9) }).success).toBe(true);
    expect(messages(rule({ targetType: 'ROLE' }))).toContain('validation.targetMismatch');
    expect(messages(rule({ targetType: 'ON_CALL', targetUserId: ID(9) }))).toContain(
      'validation.targetMismatch',
    );
    expect(rule({ targetType: 'ROLE', targetRole: 'CLIENT' }).success).toBe(false);
    expect(rule({ targetType: 'ON_CALL', channels: [] }).success).toBe(false);
    expect(rule({ targetType: 'ON_CALL', channels: ['SMS', 'SMS'] }).success).toBe(false);
    expect(rule({ targetType: 'ON_CALL', step: 21 }).success).toBe(false);
    const update = updateEscalationRuleSchema.safeParse({
      expectedUpdatedAt: T,
      targetType: 'USER',
    });
    expect(messages(update)).toContain('validation.targetMismatch');
  });

  it('email domains: lower-case hostnames, never public mail providers', () => {
    expect(emailDomainSchema.parse(' Hamad.QA ')).toBe('hamad.qa');
    expect(emailDomainSchema.safeParse('localhost').success).toBe(false);
    expect(emailDomainSchema.safeParse('bad_domain.com').success).toBe(false);
    expect(messages(emailDomainSchema.safeParse('Gmail.com'))).toContain(
      'validation.publicEmailDomain',
    );
  });

  it('Teams webhook URLs must be https', () => {
    expect(teamsWebhookUrlSchema.safeParse('https://x.webhook.office.com/abc').success).toBe(true);
    expect(teamsWebhookUrlSchema.safeParse('http://x.webhook.office.com/abc').success).toBe(false);
    expect(teamsWebhookUrlSchema.safeParse('not a url').success).toBe(false);
  });

  it('macro placeholders: only the composer variables', () => {
    expect(unknownMacroVariables('Hi {{requesterFirstName}}, {{ siteName }}')).toEqual([]);
    expect(unknownMacroVariables('{{name}} {{x}} {{name}}')).toEqual(['name', 'x']);
  });
});

describe('OpenAPI', () => {
  // The API documents every route from these schemas (fastify-type-provider-zod → JSON Schema):
  // request schemas as input, DTOs as output. Nothing may be unrepresentable.
  const schemas = Object.entries(admin as Record<string, unknown>).flatMap(([name, value]) =>
    value instanceof z.ZodType ? [[name, value] as [string, z.ZodType]] : [],
  );

  it('covers every section module', () => {
    expect(schemas.length).toBeGreaterThan(80);
  });

  it.each(schemas)('%s converts to JSON Schema', (name, schema) => {
    expect(() => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' })).not.toThrow();
    if (/(Dto|List|Response|Details)Schema$/.test(name)) {
      expect(() =>
        z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' }),
      ).not.toThrow();
    }
  });
});
