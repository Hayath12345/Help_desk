import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Focus indicators in forced-colors mode (Windows High Contrast / Contrast themes; UI-RR-3).
// Browsers drop box-shadow there, so a `focus-visible:ring-*` alone leaves a focused element
// without any indicator. Tailwind 4's `outline-hidden` keeps a transparent 2px outline in
// forced-colors mode (compiled: `@media (forced-colors: active) { outline: 2px solid transparent;
// outline-offset: 2px }`), which the browser paints in a system colour. It is applied under the
// same focus variant as the ring: unconditionally it would frame every row and field in
// forced-colors mode whether focused or not. Scanned: the console and ticket components and
// every page under app/ (round-2 verify: the portal's rows and reply box were missed);
// components/ui and components/shell are not converted yet.

const root = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = ['components/console', 'components/tickets', 'app'];

function sources(): { file: string; text: string }[] {
  return DIRS.flatMap((dir) =>
    readdirSync(`${root}${dir}`, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => {
        const file = `${dir}/${name.replaceAll('\\', '/')}`;
        return { file, text: readFileSync(`${root}${file}`, 'utf8') };
      }),
  );
}

/** Class strings: the string literals that contain Tailwind utilities with variants. */
function classStrings(text: string): string[] {
  return [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((s) => /(^|\s)[\w\-[\]:>&=*()]+:[\w-]/.test(s));
}

/** `focus-visible:` / `has-[textarea:focus-visible]:` … prefixes that turn on a ring width. */
function focusRingVariants(classes: string): string[] {
  return [...classes.matchAll(/(?:^|\s)(\S*focus-visible\S*?:)ring-(?:\d|\[)/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('forced-colors focus indicators (UI-RR-3)', () => {
  const files = sources();

  it('scans the console and ticket components and the pages', () => {
    expect(files.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        'components/console/ticket-row.tsx',
        'components/console/property-editors.tsx',
        'components/console/composer.tsx',
        'components/console/conversation.tsx',
        'components/tickets/combobox.tsx',
        'app/(portal)/tickets/_components/my-tickets.tsx',
        'app/(portal)/tickets/[ref]/_components/reply-composer.tsx',
      ]),
    );
  });

  it('pairs every focus ring with an outline-hidden under the same focus variant', () => {
    const missing: string[] = [];
    let rings = 0;
    for (const { file, text } of files) {
      for (const classes of classStrings(text)) {
        for (const variant of focusRingVariants(classes)) {
          rings += 1;
          if (!classes.split(/\s+/).includes(`${variant}outline-hidden`)) {
            missing.push(`${file}: ${variant}ring-* without ${variant}outline-hidden`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    // ticket-row, the two property editors, the combobox trigger, the composer box, the portal's
    // ticket rows and its reply box.
    expect(rings).toBeGreaterThanOrEqual(7);
  });

  it('keeps those elements free of an unconditional outline-hidden (a permanent frame in forced colours)', () => {
    const framed = files.flatMap(({ file, text }) =>
      classStrings(text)
        .filter((classes) => focusRingVariants(classes).length > 0)
        .filter((classes) => classes.split(/\s+/).includes('outline-hidden'))
        .map(() => file),
    );
    expect(framed).toEqual([]);
  });
});
