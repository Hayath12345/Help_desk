import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { motion, palette, priorityColors, statusColors } from '@loons/ui';
import { describe, expect, it } from 'vitest';

// @loons/ui ships the design tokens twice: tokens.ts (values for emails / JS) and tokens.css (the
// Tailwind theme the web app styles with). These tests keep the two in sync and hold every text
// colour pair to WCAG AA.

const css = readFileSync(createRequire(import.meta.url).resolve('@loons/ui/tokens.css'), 'utf8');

const cssColors = new Map(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map(([, name = '', value = '']) => [
    name,
    value,
  ]),
);

function cssVar(name: string): string | undefined {
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

/** tokens.ts palette key → tokens.css colour name (`primary*` is `brand*`, `border*` is `line*`). */
function cssNameOf(key: string): string {
  return key
    .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    .replace(/^primary/, 'brand')
    .replace(/^border/, 'line');
}

// WCAG 2.x relative luminance / contrast ratio (no rounding: 4.49 fails).
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens: tokens.ts ↔ tokens.css', () => {
  it('defines every palette colour with the same value in both files', () => {
    for (const [key, value] of Object.entries(palette)) {
      expect(cssColors.get(cssNameOf(key)), `palette.${key} → --color-${cssNameOf(key)}`).toBe(
        value,
      );
    }
  });

  it('defines every status and priority pill with the same values in both files', () => {
    for (const [status, { bg, fg }] of Object.entries(statusColors)) {
      const name = `status-${status.toLowerCase()}`;
      expect(cssColors.get(`${name}-bg`), name).toBe(bg);
      expect(cssColors.get(`${name}-fg`), name).toBe(fg);
    }
    for (const [priority, { bg, fg, dot }] of Object.entries(priorityColors)) {
      const name = priority.toLowerCase();
      expect(cssColors.get(`${name}-bg`), name).toBe(bg);
      expect(cssColors.get(`${name}-fg`), name).toBe(fg);
      expect(cssColors.get(`${name}-dot`), name).toBe(dot);
    }
  });

  it('has no CSS-only colours', () => {
    const fromTs = new Set([
      ...Object.keys(palette).map(cssNameOf),
      ...Object.keys(statusColors).flatMap((s) =>
        ['bg', 'fg'].map((p) => `status-${s.toLowerCase()}-${p}`),
      ),
      ...Object.keys(priorityColors).flatMap((p) =>
        ['bg', 'fg', 'dot'].map((s) => `${p.toLowerCase()}-${s}`),
      ),
    ]);
    expect([...cssColors.keys()].filter((name) => !fromTs.has(name))).toEqual([]);
  });

  it('shares the motion tokens (toast: 200 ms ease-out)', () => {
    expect(cssVar('ease-out-soft')).toBe(`cubic-bezier(${motion.ease.join(', ')})`);
    expect(cssVar('duration-toast')).toBe(`${motion.durationToast * 1000}ms`);
    expect(motion.durationToast).toBeGreaterThanOrEqual(0.15);
    expect(motion.durationToast).toBeLessThanOrEqual(0.25);
  });
});

describe('design tokens: text contrast ≥ 4.5:1 (WCAG AA)', () => {
  const textPairs: [label: string, fg: string, bg: string][] = [
    ...Object.entries(statusColors).map(
      ([s, { fg, bg }]) => [`status ${s}`, fg, bg] as [string, string, string],
    ),
    ...Object.entries(priorityColors).map(
      ([p, { fg, bg }]) => [`priority ${p}`, fg, bg] as [string, string, string],
    ),
    ['presence Online', palette.success, palette.successTint],
    ['presence Away', palette.inkMutedOnSunken, palette.surfaceSunken],
    ['success notice / badge', palette.success, palette.successTint],
    ['danger notice / badge', palette.danger, palette.dangerTint],
    ['note tag', palette.noteInk, palette.noteTag],
    ['note text', palette.noteInk, palette.noteBg],
    ['brand badge / link on tint', palette.primaryInk, palette.primaryTint],
    ['secondary badge', palette.inkSecondary, palette.surfaceSunken],
    ['muted text on surface', palette.inkMuted, palette.surface],
    ['placeholder / search on surface-muted', palette.inkMuted, palette.surfaceMuted],
    ['muted text on page', palette.inkMuted, palette.page],
    ['link on surface', palette.primaryInk, palette.surface],
    ['primary button', palette.surface, palette.primary],
    ['toast', palette.surface, palette.ink],
    ['toast description', palette.inkSubtle, palette.ink],
    ['P1 banner', palette.surface, palette.dangerAlert],
    ['P1 banner button', palette.dangerAlertInk, palette.surface],
  ];

  it.each(textPairs)('%s: %s on %s', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
