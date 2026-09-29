// Ticket tags typed in the console right panel ("+ tag"). Mirrors the PATCH /tickets rule in the
// shared updateTicketSchema: lower-case letters, digits and dashes, ≤ 40 characters, ≤ 20 tags.

import { TICKET_LIMITS } from '@loons/shared';

const TAG_FORMAT = /^[a-z0-9][a-z0-9-]*$/u;

/** "Brute Force " → "brute-force" (design: trim, lower-case, spaces → dashes). */
export function normalizeTag(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-')
    .replace(/-{2,}/gu, '-');
}

export type TagProblem = 'format' | 'tooLong' | 'limit';

/**
 * Why `tag` (already normalised) can't be added to `existing`, or null. A tag that is already
 * there is not a problem — adding it is simply a no-op.
 */
export function tagProblem(tag: string, existing: readonly string[]): TagProblem | null {
  if (!TAG_FORMAT.test(tag)) return 'format';
  if (tag.length > TICKET_LIMITS.tagMax) return 'tooLong';
  if (!existing.includes(tag) && existing.length >= TICKET_LIMITS.tagsPerTicket) return 'limit';
  return null;
}
