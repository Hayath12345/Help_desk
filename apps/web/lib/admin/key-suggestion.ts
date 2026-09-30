// Key suggestions for create forms (docs/PHASE4_CONTRACT.md E4): the shared `slugifyKey` of the
// English label, plus the API's collision rule (`-2`, `-3`… — `_2`, `_3`… for `_` keys — against
// every existing key, archived rows included), so the key the admin sees is the key they get.

import { slugifyKey } from '@loons/shared';

export interface KeySuggestionOptions {
  /** `-` (default; categories, teams, sites…) or `_` (custom fields: keys of ticket values). */
  separator?: '-' | '_';
  /** Default 48 (the shared default). */
  maxLength?: number;
}

/** '' when the label has nothing usable (e.g. Arabic only): the API then generates one. */
export function suggestKey(
  label: string,
  taken: Iterable<string> = [],
  options: KeySuggestionOptions = {},
): string {
  const maxLength = options.maxLength ?? 48;
  const base = slugifyKey(label, { separator: options.separator, maxLength });
  if (!base) return '';
  const used = new Set(Array.from(taken, (key) => key.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `${options.separator ?? '-'}${n}`;
    const stem = base.slice(0, Math.max(1, maxLength - suffix.length)).replace(/[-_]+$/, '');
    const candidate = `${stem}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
