import { randomBytes } from 'node:crypto';
import { ADMIN_LIMITS, slugifyKey } from '@loons/shared';

// Keys (decision E4): generated from the English label when the admin leaves the key empty, with a
// numeric suffix on a collision with any row (archived ones included), editable while creating,
// immutable afterwards. Two creates racing for the same key: the second insert fails on the unique
// index and answers 409 `duplicate` (or take `advisoryLock(tx, 'key:<Model>')` first).

export interface GenerateKeyInput {
  /** The English label. */
  label: string;
  /** '-' (default) or '_' (custom-field keys, which are JSON keys of ticket values). */
  separator?: '-' | '_';
  /** Used when the label yields no usable key (e.g. Arabic only): `<prefix>-<random>`. */
  fallbackPrefix: string;
  maxLength?: number;
  /** Which of `candidates` are taken in the key's scope (archived rows included). */
  taken: (candidates: string[]) => Promise<Iterable<string>>;
}

const SUFFIXES = 20;

function random(): string {
  return randomBytes(3).toString('hex');
}

/** A free key for `label`: its slug, else slug-2 … slug-21, else slug-<random>. */
export async function generateKey(input: GenerateKeyInput): Promise<string> {
  const separator = input.separator ?? '-';
  const maxLength = Math.min(input.maxLength ?? 48, ADMIN_LIMITS.keyMax - 8);
  const base =
    slugifyKey(input.label, { separator, maxLength }) ||
    `${slugifyKey(input.fallbackPrefix, { separator }) || 'item'}${separator}${random()}`;
  const candidates = [base];
  for (let n = 2; n < SUFFIXES + 2; n++) candidates.push(`${base}${separator}${n}`);
  const taken = new Set(await input.taken(candidates));
  return candidates.find((c) => !taken.has(c)) ?? `${base}${separator}${random()}`;
}
