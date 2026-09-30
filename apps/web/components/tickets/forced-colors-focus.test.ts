import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Focus indicators in forced-colors mode (Windows High Contrast / Contrast themes; UI-RR-3).
// Browsers drop box-shadow there, so a `focus-visible:ring-*` alone leaves a focused element
// without any indicator. Tailwind 4's `outline-hidden` keeps a transparent 2px outline in
// forced-colors mode (compiled: `@media (forced-colors: active) { outline: 2px solid transparent;
// outline-offset: 2px }`), which the browser paints in a system colour. It is applied under the
// same focus variant as the ring: unconditionally it would frame every row and field in
// forced-colors mode whether focused or not. The same goes for menu / listbox items whose only
// focus indicator is a background (`focus:bg-*`, `data-[selected=true]:bg-*`): forced colours
// flatten backgrounds, so they carry `outline-hidden` under that variant, never unconditionally.
// Scanned: the console and ticket components, every page under app/ (round-2 verify: the portal's
// rows and reply box were missed) and, since Phase 3, the shadcn primitives (components/ui) and
// the shell (components/shell, where the notification bell lives); since Phase 4, the admin kit
// and sections (components/admin).

const root = fileURLToPath(new URL('../..', import.meta.url));
const DIRS = [
  'components/console',
  'components/tickets',
  'app',
  'components/ui',
  'components/shell',
  'components/admin',
];

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

/**
 * `focus-visible:` / `focus-within:` / `has-[textarea:focus-visible]:` … prefixes that turn on a
 * ring width (`ring-0` removes a ring, so it doesn't count).
 */
function focusRingVariants(classes: string): string[] {
  return [...classes.matchAll(/(?:^|\s)(\S*focus-(?:visible|within)\S*?:)ring-(?:[1-9]|\[)/g)].map(
    (m) => m[1] ?? '',
  );
}

/** `focus:` / `data-[selected=true]:` / `data-highlighted:` prefixes of a background indicator. */
function focusBackgroundVariants(classes: string): string[] {
  return [
    ...classes.matchAll(
      /(?:^|\s)(focus:|data-highlighted:|data-selected:|data-\[selected=true\]:)bg-/g,
    ),
  ].map((m) => m[1] ?? '');
}

const tokens = (classes: string) => classes.split(/\s+/);

describe('forced-colors focus indicators (UI-RR-3)', () => {
  const files = sources();

  it('scans the console, ticket, ui, shell and admin components and the pages', () => {
    expect(files.map((f) => f.file)).toEqual(
      expect.arrayContaining([
        'components/console/ticket-row.tsx',
        'components/console/property-editors.tsx',
        'components/console/composer.tsx',
        'components/console/conversation.tsx',
        'components/tickets/combobox.tsx',
        'app/(portal)/tickets/_components/my-tickets.tsx',
        'app/(portal)/tickets/[ref]/_components/reply-composer.tsx',
        'components/ui/input.tsx',
        'components/ui/select.tsx',
        'components/ui/dropdown-menu.tsx',
        'components/shell/console-search.tsx',
        'components/shell/notification-bell.tsx',
        'components/admin/kit/admin-table.tsx',
        'components/admin/kit/admin-sheet.tsx',
        'components/admin/kit/reorder.tsx',
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
          if (!tokens(classes).includes(`${variant}outline-hidden`)) {
            missing.push(`${file}: ${variant}ring-* without ${variant}outline-hidden`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    // Console / ticket / portal rows and fields (7 before Phase 3), plus the ui primitives
    // (checkbox, radio, switch, input, textarea, select, scroll area, input group, field label),
    // the console search box and the notification bell's items.
    expect(rings).toBeGreaterThanOrEqual(18);
  });

  it('gives background-only focus indicators (menu, listbox items) an outline under the same variant', () => {
    const missing: string[] = [];
    let items = 0;
    for (const { file, text } of files) {
      for (const classes of classStrings(text)) {
        for (const variant of focusBackgroundVariants(classes)) {
          items += 1;
          if (!tokens(classes).includes(`${variant}outline-hidden`)) {
            missing.push(`${file}: ${variant}bg-* without ${variant}outline-hidden`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
    // dropdown items ×4, select item, command item, the ticket combobox's option.
    expect(items).toBeGreaterThanOrEqual(7);
  });

  it('keeps those elements free of an unconditional outline-hidden (a permanent frame in forced colours)', () => {
    const framed = files.flatMap(({ file, text }) =>
      classStrings(text)
        .filter(
          (classes) =>
            focusRingVariants(classes).length > 0 || focusBackgroundVariants(classes).length > 0,
        )
        .filter((classes) => tokens(classes).includes('outline-hidden'))
        .map(() => file),
    );
    expect(framed).toEqual([]);
  });
});
