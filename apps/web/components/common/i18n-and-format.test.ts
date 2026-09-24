import { ADMIN_SECTIONS, PRIORITIES, TICKET_STATUSES } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import {
  firstNameOf,
  formatDuration,
  formatNumber,
  formatRelativeTime,
  formatTicketNumber,
  initialsFrom,
} from '@/lib/format';
import arAdmin from '@/messages/ar/admin.json';
import arCommon from '@/messages/ar/common.json';
import arConsole from '@/messages/ar/console.json';
import arPortal from '@/messages/ar/portal.json';
import enAdmin from '@/messages/en/admin.json';
import enCommon from '@/messages/en/common.json';
import enConsole from '@/messages/en/console.json';
import enPortal from '@/messages/en/portal.json';

type Tree = { [key: string]: string | Tree };

function leafKeys(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leafKeys(value, `${prefix}${key}.`),
  );
}

function leafValues(tree: Tree): string[] {
  return Object.values(tree).flatMap((value) =>
    typeof value === 'string' ? [value] : leafValues(value),
  );
}

const namespaces = {
  common: [enCommon, arCommon],
  portal: [enPortal, arPortal],
  console: [enConsole, arConsole],
  admin: [enAdmin, arAdmin],
} as const satisfies Record<string, readonly [Tree, Tree]>;

describe('web-shells message catalogues', () => {
  for (const [ns, [en, ar]] of Object.entries(namespaces)) {
    it(`${ns}: English and Arabic define exactly the same keys`, () => {
      expect(leafKeys(ar).sort()).toEqual(leafKeys(en).sort());
    });

    it(`${ns}: no empty strings`, () => {
      for (const value of [...leafValues(en), ...leafValues(ar)]) expect(value.trim()).not.toBe('');
    });
  }

  it('has a label for every ticket status and priority (reused by Phase 2)', () => {
    for (const status of TICKET_STATUSES) {
      expect(enCommon.status[status]).toBeTruthy();
      expect(arCommon.status[status]).toBeTruthy();
    }
    for (const priority of PRIORITIES) {
      expect(enCommon.priority[priority]).toMatch(new RegExp(`^${priority} `));
      expect(arCommon.priority[priority]).toMatch(new RegExp(`^${priority} `));
    }
  });

  it('has a title and description for every admin section', () => {
    for (const section of ADMIN_SECTIONS) {
      expect(enAdmin.sections[section].title).toBeTruthy();
      expect(arAdmin.sections[section].description).toBeTruthy();
    }
  });

  it('names the product "مكتب دعم لونز" in Arabic, as the design does (the logo stays Latin)', () => {
    expect(arCommon.appName).toBe('مكتب دعم لونز');
    expect(arCommon.brand).toBe(enCommon.brand);
    for (const [ns, [, ar]] of Object.entries(namespaces)) {
      for (const value of leafValues(ar)) {
        // Any "… desk of Loons" phrase must be the one product name (no مكتب مساعدة لونز etc.).
        if (/مكتب\s+\S+\s+لونز/.test(value)) expect(value, ns).toContain('مكتب دعم لونز');
      }
    }
  });

  it('keeps the language toggle labels pointing at the other language', () => {
    expect(enCommon.languageLabel).toBe('العربية');
    expect(arCommon.languageLabel).toBe('English');
  });
});

describe('lib/format', () => {
  const now = Date.UTC(2026, 8, 23, 12, 0, 0);

  it('formats ticket numbers', () => {
    expect(formatTicketNumber(4817)).toBe('LG-4817');
  });

  it('uses Latin digits in Arabic', () => {
    expect(formatNumber(12345, 'en')).toBe('12,345');
    expect(formatNumber(12345, 'ar')).toMatch(/12.345/);
    expect(formatNumber(12345, 'ar')).not.toMatch(/[٠-٩]/);
  });

  it('formats compact relative times', () => {
    expect(formatRelativeTime(now - 20_000, 'en', now)).toBe('now');
    expect(formatRelativeTime(now - 5 * 60_000, 'en', now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, 'en', now)).toBe('3h ago');
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), 'en', now)).toBe(
      '2d ago',
    );
    expect(formatRelativeTime(now - 5 * 60_000, 'ar', now)).toContain('5');
  });

  it('formats SLA durations like the design', () => {
    expect(formatDuration(45 * 60_000, 'en')).toBe('45m');
    expect(formatDuration(65 * 60_000, 'en')).toBe('1h 05m');
    expect(formatDuration(3 * 3_600_000, 'en')).toBe('3h');
    expect(formatDuration(50 * 3_600_000, 'en')).toBe('2d');
    expect(formatDuration(-10_000, 'en')).toBe('0m');
  });

  it('derives first names and initials without honorifics', () => {
    expect(firstNameOf('Dr. Aisha Al-Kuwari')).toBe('Aisha');
    expect(firstNameOf('Maya Ruiz')).toBe('Maya');
    expect(initialsFrom('Maya Ruiz')).toBe('MR');
    expect(initialsFrom('Capt. Omar Haddad')).toBe('OH');
    expect(initialsFrom('  ')).toBe('');
  });
});
