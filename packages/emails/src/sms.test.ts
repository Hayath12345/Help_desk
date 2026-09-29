import { describe, expect, it } from 'vitest';
import { buildSmsText, smsEncoding, smsLength, smsSegments, type SmsTextInput } from './sms.ts';

const RLM = String.fromCharCode(0x200f);
const PROD_URL = 'https://helpdesk.loonsgroup.com/console/inbox?ticket=LG-4821';
const LOCAL_URL = 'http://localhost:3000/console/inbox?ticket=LG-4821';

const soc: SmsTextInput = {
  locale: 'en',
  ticketNumber: 4821,
  priority: 'P1',
  teamName: { en: 'SOC', ar: 'مركز العمليات الأمنية (SOC)' },
  categoryName: { en: 'Cybersecurity / SOC', ar: 'الأمن السيبراني / SOC' },
  url: PROD_URL,
};

describe('SMS encoding and segments', () => {
  it('counts GSM-7 septets (extension characters count twice) and UCS-2 code units', () => {
    expect(smsEncoding('LG-1 P1 SOC https://x.example/?a=1')).toBe('GSM-7');
    expect(smsEncoding('café £5 @home')).toBe('GSM-7');
    expect(smsEncoding('€ [x] {y} ~ | ^ \\')).toBe('GSM-7');
    expect(smsLength('€[]')).toBe(6);
    expect(smsEncoding('مرحبا')).toBe('UCS-2');
    expect(smsEncoding('smart ’quote’')).toBe('UCS-2');
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
    expect(smsSegments('ب'.repeat(70))).toBe(1);
    expect(smsSegments('ب'.repeat(71))).toBe(2);
    expect(smsSegments('ب'.repeat(134))).toBe(2);
  });
});

describe('buildSmsText', () => {
  it('English: "LG-n P1 <team> <category> <console link>" in one GSM-7 segment', () => {
    const text = buildSmsText(soc);
    expect(text).toBe(`LG-4821 P1 SOC Cybersecurity / SOC ${PROD_URL}`);
    expect(smsEncoding(text)).toBe('GSM-7');
    expect(smsLength(text)).toBe(95);
    expect(smsSegments(text)).toBe(1);
    expect(buildSmsText({ ...soc, url: LOCAL_URL })).toHaveLength(85);
  });

  it('English with the longest seeded names still fits one segment', () => {
    const text = buildSmsText({
      ...soc,
      teamName: 'Account Management',
      categoryName: 'Building Automation & Smart Building',
    });
    expect(text).toBe(
      `LG-4821 P1 Account Management Building Automation & Smart Building ${PROD_URL}`,
    );
    expect(smsLength(text)).toBe(127);
    expect(smsSegments(text)).toBe(1);
  });

  it('Arabic: localized names, right-to-left mark, UCS-2 (two parts with a real link)', () => {
    const text = buildSmsText({ ...soc, locale: 'ar' });
    expect(text).toBe(
      `${RLM}LG-4821 P1 مركز العمليات الأمنية (SOC) الأمن السيبراني / SOC ${PROD_URL}`,
    );
    expect(smsEncoding(text)).toBe('UCS-2');
    expect(smsLength(text)).toBe(text.length);
    expect(text.length).toBe(122);
    expect(smsSegments(text)).toBe(2);
    // Names are not cut to a few letters when one segment is out of reach anyway.
    expect(text).toContain('مركز العمليات الأمنية (SOC)');
  });

  it('Arabic with Latin-only names stays GSM-7 (no mark added)', () => {
    const text = buildSmsText({ ...soc, locale: 'ar', teamName: 'SOC', categoryName: 'CCTV' });
    expect(text).toBe(`LG-4821 P1 SOC CCTV ${PROD_URL}`);
    expect(smsEncoding(text)).toBe('GSM-7');
  });

  it('Arabic falls back to the English name when there is no Arabic one', () => {
    const text = buildSmsText({ ...soc, locale: 'ar', teamName: { en: 'NOC', ar: '' } });
    expect(text.startsWith(`${RLM}LG-4821 P1 NOC الأمن السيبراني / SOC `)).toBe(true);
  });

  it('never carries a subject or client / requester name: only number, P1, team, category, link', () => {
    const text = buildSmsText(soc);
    expect(text.split(' ')).toEqual([
      'LG-4821',
      'P1',
      'SOC',
      'Cybersecurity',
      '/',
      'SOC',
      PROD_URL,
    ]);
  });

  it('shortens long names (longer first) to keep one segment, never the number or link', () => {
    const text = buildSmsText({
      ...soc,
      teamName: 'T'.repeat(40),
      categoryName: 'C'.repeat(40),
      url: `https://helpdesk.loonsgroup.com/console/inbox?ticket=LG-4821&pad=${'p'.repeat(40)}`,
    });
    expect(smsSegments(text)).toBe(1);
    expect(smsLength(text)).toBeLessThanOrEqual(160);
    expect(text.startsWith('LG-4821 P1 T')).toBe(true);
    expect(text.endsWith(`pad=${'p'.repeat(40)}`)).toBe(true);
    const [, , team = '', category = ''] = text.split(' ');
    expect(Math.abs(team.length - category.length)).toBeLessThanOrEqual(1);
    expect(team.length).toBeLessThan(40);
  });

  it('caps names at 40 characters', () => {
    const text = buildSmsText({ ...soc, teamName: 'x'.repeat(100), categoryName: 'y' });
    expect(text).toContain(` ${'x'.repeat(40)} y `);
  });

  it('turns typographic punctuation into GSM-7 in English and strips control characters', () => {
    const text = buildSmsText({
      ...soc,
      teamName: 'Ops’ “A” – team',
      categoryName: `Line\nbreak\t${String.fromCharCode(0x202e)}x`,
    });
    expect(text).toBe(`LG-4821 P1 Ops' "A" - team Line break x ${PROD_URL}`);
    expect(smsEncoding(text)).toBe('GSM-7');
  });

  it('requires an absolute http(s) link', () => {
    expect(() => buildSmsText({ ...soc, url: '/console/inbox' })).toThrow(/absolute http/);
    expect(() => buildSmsText({ ...soc, url: 'javascript:alert(1)' })).toThrow(/absolute http/);
  });
});
