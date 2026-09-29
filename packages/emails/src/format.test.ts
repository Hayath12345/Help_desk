import { describe, expect, it } from 'vitest';
import { BLOCK_MAX_CHARS } from './blocks.ts';
import {
  EMPTY_VALUE,
  buildTicketList,
  formatCount,
  formatDurationMinutes,
  formatEmailDate,
  formatEmailDateTime,
  formatShortDateTime,
  formatTargetDuration,
  localizedName,
  orEmpty,
  priorityLabel,
  slaTargetLabel,
  ticketLinks,
  ticketStatusLabel,
  ticketTemplateVariables,
  ticketTypeLabel,
  unassignedLabel,
} from './format.ts';

const TZ = 'Asia/Qatar';
const at = new Date('2026-09-29T11:05:00Z'); // 14:05 in Doha

describe('labels', () => {
  it('match the web app wording in both languages', () => {
    expect(priorityLabel('P1', 'en')).toBe('P1 Critical');
    expect(priorityLabel('P4', 'en')).toBe('P4 Low');
    expect(priorityLabel('P1', 'ar')).toBe('P1 حرجة');
    expect(priorityLabel('P3', 'ar')).toBe('P3 متوسطة');
    expect(ticketTypeLabel('SECURITY_INCIDENT', 'en')).toBe('Security Incident');
    expect(ticketTypeLabel('INCIDENT', 'ar')).toBe('عطل');
    expect(ticketStatusLabel('PENDING', 'en')).toBe('Pending');
    expect(ticketStatusLabel('SOLVED', 'ar')).toBe('تم الحل');
    expect(slaTargetLabel('FIRST_REPLY', 'en')).toBe('first reply');
    expect(slaTargetLabel('RESOLUTION', 'ar')).toBe('الحل');
    expect(unassignedLabel('en')).toBe('Unassigned');
    expect(unassignedLabel('ar')).toBe('غير مسندة');
  });

  it('orEmpty and localizedName', () => {
    expect(orEmpty(null)).toBe(EMPTY_VALUE);
    expect(orEmpty('  ')).toBe('—');
    expect(orEmpty(' a \n b ')).toBe('a b');
    expect(orEmpty(0)).toBe('0');
    expect(localizedName({ en: 'SOC', ar: 'مركز العمليات الأمنية (SOC)' }, 'ar')).toBe(
      'مركز العمليات الأمنية (SOC)',
    );
    expect(localizedName({ en: 'Other', ar: ' ' }, 'ar')).toBe('Other');
    expect(localizedName({ en: 'SOC', ar: 'س' }, 'en')).toBe('SOC');
    expect(localizedName('Plain', 'ar')).toBe('Plain');
    expect(localizedName(null, 'en')).toBe('');
  });
});

describe('durations', () => {
  it('counts in English', () => {
    expect(formatCount(1, 'minute', 'en')).toBe('1 minute');
    expect(formatCount(15, 'minute', 'en')).toBe('15 minutes');
    expect(formatCount(1, 'businessDay', 'en')).toBe('1 business day');
  });

  it('uses the Arabic plural forms (1, 2, 3–10, 11–99, 100+)', () => {
    expect(
      [1, 2, 3, 10, 11, 15, 99, 100, 101, 103].map((n) => formatCount(n, 'minute', 'ar')),
    ).toEqual([
      'دقيقة واحدة',
      'دقيقتان',
      '3 دقائق',
      '10 دقائق',
      '11 دقيقة',
      '15 دقيقة',
      '99 دقيقة',
      '100 دقيقة',
      '101 دقيقة',
      '103 دقائق',
    ]);
    expect(formatCount(2, 'hour', 'ar')).toBe('ساعتان');
    expect(formatCount(5, 'day', 'ar')).toBe('5 أيام');
    expect(formatCount(2, 'businessDay', 'ar')).toBe('يوما عمل');
  });

  it('SLA target windows: minutes, business hours / days, calendar days', () => {
    const cases: [number, boolean, string, string][] = [
      [15, false, '15 minutes', '15 دقيقة'],
      [60, false, '1 hour', 'ساعة واحدة'],
      [240, true, '4 business hours', '4 ساعات عمل'],
      [540, true, '1 business day', 'يوم عمل واحد'],
      [1080, true, '2 business days', 'يوما عمل'],
      [1440, false, '1 day', 'يوم واحد'],
      [90, true, '1 hour 30 minutes', 'ساعة واحدة و30 دقيقة'],
      [125, false, '2 hours 5 minutes', 'ساعتان و5 دقائق'],
    ];
    for (const [minutes, business, en, ar] of cases) {
      expect(formatTargetDuration(minutes, business, 'en'), `${minutes}`).toBe(en);
      expect(formatTargetDuration(minutes, business, 'ar'), `${minutes}`).toBe(ar);
    }
    expect(formatTargetDuration(480, true, 'en', 480)).toBe('1 business day');
  });

  it('elapsed / remaining time', () => {
    expect(formatDurationMinutes(-5, 'en')).toBe('0 minutes');
    expect(formatDurationMinutes(45, 'en')).toBe('45 minutes');
    expect(formatDurationMinutes(65, 'en')).toBe('1 hour 5 minutes');
    expect(formatDurationMinutes(1500, 'en')).toBe('1 day 1 hour');
    expect(formatDurationMinutes(2880, 'en')).toBe('2 days');
    expect(formatDurationMinutes(65, 'ar')).toBe('ساعة واحدة و5 دقائق');
  });
});

describe('dates', () => {
  it('are shown in the given IANA zone with the zone name', () => {
    expect(formatEmailDateTime(at, 'en', TZ)).toBe('Tue, Sep 29, 2026, 14:05 GMT+3');
    expect(formatEmailDateTime(at, 'en', 'UTC')).toBe('Tue, Sep 29, 2026, 11:05 UTC');
    const ar = formatEmailDateTime(at, 'ar', TZ);
    expect(ar).toContain('14:05'); // Latin digits, 24-hour clock
    expect(ar).toContain('سبتمبر');
    expect(ar).toContain('2026');
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(formatEmailDate(at, 'en', TZ)).toBe('Sep 29, 2026');
    expect(formatShortDateTime(at, 'en', TZ)).toBe('Sep 29, 14:05');
    // Near midnight the zone changes the calendar day.
    expect(formatEmailDate('2026-09-29T22:30:00Z', 'en', TZ)).toBe('Sep 30, 2026');
    expect(formatEmailDate('2026-09-29T22:30:00Z', 'en', 'UTC')).toBe('Sep 29, 2026');
  });

  it('reject an unknown zone or an invalid date', () => {
    expect(() => formatEmailDateTime(at, 'en', 'Mars/Olympus')).toThrow(RangeError);
    expect(() => formatEmailDateTime('not a date', 'en', TZ)).toThrow(RangeError);
  });
});

describe('ticketTemplateVariables', () => {
  it('formats a ticket for English and Arabic, with placeholders for missing values', () => {
    const facts = {
      number: 4821,
      subject: 'Cameras  offline\nsince 8',
      type: 'INCIDENT' as const,
      priority: 'P1' as const,
      status: 'OPEN' as const,
      teamName: { en: 'SOC', ar: 'مركز العمليات الأمنية (SOC)' },
      categoryName: { en: 'CCTV & Video Surveillance', ar: 'كاميرات المراقبة' },
      subtypeName: null,
      orgName: { en: 'Qatar Airways', ar: null },
      requesterName: 'Dana',
      siteName: undefined,
      assetId: '',
      assigneeName: null,
      createdAt: at,
      firstReplyDueAt: null,
      description: 'Line 1\n\nLine 2',
    };
    expect(ticketTemplateVariables(facts, { locale: 'en', timeZone: TZ })).toEqual({
      ticketNumber: 'LG-4821',
      ticketSubject: 'Cameras offline since 8',
      ticketType: 'Incident',
      priority: 'P1 Critical',
      ticketStatus: 'Open',
      teamName: 'SOC',
      categoryName: 'CCTV & Video Surveillance',
      subtypeName: '—',
      orgName: 'Qatar Airways',
      requesterName: 'Dana',
      siteName: '—',
      assetId: '—',
      assigneeName: 'Unassigned',
      createdAt: 'Tue, Sep 29, 2026, 14:05 GMT+3',
      firstReplyDueAt: '—',
      description: 'Line 1\n\nLine 2', // block variable: kept as written
    });
    const ar = ticketTemplateVariables(
      { ...facts, number: 'LG-4821', assigneeName: 'Omar' },
      { locale: 'ar', timeZone: TZ },
    );
    expect(ar.priority).toBe('P1 حرجة');
    expect(ar.teamName).toBe('مركز العمليات الأمنية (SOC)');
    expect(ar.orgName).toBe('Qatar Airways'); // no Arabic name: English
    expect(ar.assigneeName).toBe('Omar');
    expect(ar.ticketNumber).toBe('LG-4821');
    expect(
      ticketTemplateVariables({ ...facts, description: null }, { locale: 'en', timeZone: TZ })
        .description,
    ).toBe('');
  });
});

describe('buildTicketList', () => {
  const items = [
    {
      number: 4821,
      subject: 'Printer jam https://evil.example [x](y)',
      orgName: { en: 'Qatar Airways', ar: 'الخطوط القطرية' },
      createdAt: at,
    },
    { number: 'LG-4822', subject: 'Line\nbreak', orgName: null, createdAt: at },
  ];

  it('writes one plain line per ticket', () => {
    expect(buildTicketList(items, { locale: 'en', timeZone: TZ })).toBe(
      [
        '• LG-4821 · Printer jam https://evil.example [x](y) · Qatar Airways · Sep 29, 14:05',
        '• LG-4822 · Line break · — · Sep 29, 14:05',
      ].join('\n'),
    );
    const ar = buildTicketList(items, { locale: 'ar', timeZone: TZ }).split('\n');
    expect(ar).toHaveLength(2);
    expect(ar[0]).toContain('الخطوط القطرية');
    expect(buildTicketList([], { locale: 'en', timeZone: TZ })).toBe('');
  });

  it('cuts long subjects and sums up what does not fit in the block limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      number: 1000 + i,
      subject: `Subject ${i} ${'x'.repeat(100)}`,
      createdAt: at,
    }));
    const list = buildTicketList(many, { locale: 'en', timeZone: TZ });
    const lines = list.split('\n');
    expect(Array.from(list).length).toBeLessThanOrEqual(BLOCK_MAX_CHARS);
    expect(lines[0]).toContain('…'); // subject cut at 80 characters
    const shown = lines.length - 1;
    expect(lines.at(-1)).toBe(`…and ${60 - shown} more tickets`);
    const ar = buildTicketList(many, { locale: 'ar', timeZone: TZ }).split('\n');
    expect(ar.at(-1)).toMatch(/^…و\d+ (تذكرة|تذاكر) أخرى$/);
    const tight = buildTicketList(many.slice(0, 3), { locale: 'en', timeZone: TZ, maxChars: 150 });
    expect(tight.split('\n')).toHaveLength(2);
    expect(tight.split('\n')[1]).toBe('…and 2 more tickets');
  });
});

describe('ticketLinks', () => {
  it('builds the portal and console links; ackUrl opens the console (D5)', () => {
    expect(ticketLinks('http://localhost:3000', 4821)).toEqual({
      portalUrl: 'http://localhost:3000/tickets/LG-4821',
      consoleUrl: 'http://localhost:3000/console/inbox?ticket=LG-4821',
      ackUrl: 'http://localhost:3000/console/inbox?ticket=LG-4821',
    });
    expect(ticketLinks('https://x.example/app', 'LG-1').consoleUrl).toBe(
      'https://x.example/app/console/inbox?ticket=LG-1',
    );
  });
});
