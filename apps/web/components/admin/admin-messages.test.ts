import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADMIN_SECTIONS, ADMIN_SECTION_GROUPS } from '@loons/shared';
import { describe, expect, it } from 'vitest';
import { NAMESPACES } from '@/i18n/messages';
import { ADMIN_SECTION_NAMESPACE } from '@/lib/admin/sections';

// EN/AR parity for the admin message files: admin.json (shared kit strings, section titles) and
// admin-<group>.json (one per navigation group, filled by the section lanes). Every messages file
// must be a registered namespace (i18n/messages.ts) — an unregistered file is never loaded.

const root = fileURLToPath(new URL('../../messages/', import.meta.url));
type Tree = { [key: string]: string | Tree };

function load(locale: 'en' | 'ar', file: string): Tree {
  return JSON.parse(readFileSync(`${root}${locale}/${file}`, 'utf8')) as Tree;
}

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}${key}`, value]] : leaves(value, `${prefix}${key}.`),
  );
}

/** ICU arguments used by a message (`{label}`, `{count, plural, …}` → count). */
function argumentsOf(message: string): string[] {
  return [...new Set([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1] ?? ''))].sort();
}

const adminFiles = readdirSync(`${root}en`).filter((f) => /^admin(-[a-z]+)?\.json$/.test(f));

describe('admin messages (EN/AR)', () => {
  it('has admin.json and one file per section group', () => {
    expect(adminFiles.sort()).toEqual(
      [
        'admin.json',
        'admin-comms.json',
        'admin-people.json',
        'admin-setup.json',
        'admin-sla.json',
      ].sort(),
    );
    expect(
      readdirSync(`${root}ar`)
        .filter((f) => f.startsWith('admin'))
        .sort(),
    ).toEqual(adminFiles.sort());
  });

  for (const file of adminFiles) {
    it(`${file}: same keys, no empty strings, same ICU arguments`, () => {
      const en = new Map(leaves(load('en', file)));
      const ar = new Map(leaves(load('ar', file)));
      expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, value] of [...en, ...ar]) expect(value.trim(), key).not.toBe('');
      for (const [key, value] of en) {
        expect(argumentsOf(ar.get(key) ?? ''), key).toEqual(argumentsOf(value));
      }
    });
  }

  it('registers every messages file as a namespace, and each section namespace exists', () => {
    const files = readdirSync(`${root}en`).map((f) => f.replace(/\.json$/, ''));
    expect([...NAMESPACES].sort()).toEqual(files.sort());
    for (const ns of Object.values(ADMIN_SECTION_NAMESPACE)) expect(files).toContain(ns);
  });

  it('names every section and navigation group in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const admin = load(locale, 'admin.json') as {
        sections: Record<string, { title: string; description: string }>;
        groups: Record<string, string>;
      };
      for (const section of ADMIN_SECTIONS) {
        expect(admin.sections[section]?.title, `${locale} ${section}`).toBeTruthy();
        expect(admin.sections[section]?.description, `${locale} ${section}`).toBeTruthy();
      }
      for (const group of ADMIN_SECTION_GROUPS) {
        expect(admin.groups[group.key], `${locale} ${group.key}`).toBeTruthy();
      }
    }
  });

  it('uses the contract wording for the conflict state and the Arabic hint', () => {
    const en = load('en', 'admin.json') as { kit: Record<string, string> };
    expect(en.kit.conflictTitle).toBe('Someone else changed this — reload');
    expect(en.kit.arabicMissing).toBe('Arabic missing — English is shown');
  });

  it('has a message for every validation key the admin contracts and the admin API send', () => {
    // Keys the shared schemas and the API put in 400 issues (`validation.<key>`): the sections
    // look in their own namespace first, then in validation.json, which must have them all.
    const sources = ['../../../../packages/shared/src/schemas', '../../../api/src']
      .map((dir) => fileURLToPath(new URL(dir, import.meta.url)))
      .flatMap((dir) =>
        readdirSync(dir, { recursive: true, encoding: 'utf8' })
          .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
          .map((f) => readFileSync(`${dir}/${f}`, 'utf8')),
      );
    const used = new Set(
      sources.flatMap((text) =>
        [...text.matchAll(/['"`]validation\.([A-Za-z]+)['"`]/g)].map((m) => m[1] ?? ''),
      ),
    );
    expect(used.size).toBeGreaterThan(20);
    for (const locale of ['en', 'ar'] as const) {
      const validation = JSON.parse(
        readFileSync(`${root}${locale}/validation.json`, 'utf8'),
      ) as Record<string, string>;
      const sectionFiles = ['admin-setup', 'admin-sla', 'admin-people', 'admin-comms'].map(
        (ns) => (load(locale, `${ns}.json`).validation ?? {}) as Record<string, string>,
      );
      for (const key of used) {
        const found = validation[key] ?? sectionFiles.find((v) => v[key])?.[key];
        expect(found, `${locale} validation.${key}`).toBeTruthy();
      }
      // The generic admin keys live in validation.json itself (any section may meet them).
      for (const key of ['keyFormat', 'nothingToChange', 'duplicateValue', 'reorderMismatch']) {
        expect(validation[key], `${locale} validation.json ${key}`).toBeTruthy();
      }
    }
  });

  it('isolates LTR phone numbers, URLs and domains inside Arabic text (RTL-1)', () => {
    // Without LRI … PDI, "+974 5555 1234" renders as "1234 5555 974+" in an RTL paragraph and
    // "https://" as "//:https".
    const LRI = String.fromCharCode(0x2066);
    const PDI = String.fromCharCode(0x2069);
    const isolated = new RegExp(`${LRI}[^${PDI}]*${PDI}`, 'g');
    const ltrToken = /\+\d[\d ]*\d|https?:\/\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
    const files = [...adminFiles, 'validation.json'];
    let checked = 0;
    for (const file of files) {
      for (const [key, value] of leaves(load('ar', file))) {
        if (!ltrToken.test(value)) continue;
        checked += 1;
        expect(value.replace(isolated, ''), `ar/${file} ${key}`).not.toMatch(ltrToken);
      }
    }
    expect(checked).toBeGreaterThan(5);
    const people = load('ar', 'admin-people.json') as { staff: { form: { phoneHint: string } } };
    expect(people.staff.form.phoneHint).toContain(`${LRI}+974 5555 1234${PDI}`);
  });
});
