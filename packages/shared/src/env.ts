// Environment parsing shared by the web app, the API and the seed, so one `.env` value always
// means the same thing everywhere.

import { DEFAULT_STAFF_EMAIL_DOMAIN } from './auth.ts';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Parses a boolean flag. Unset or blank → `fallback`; true/1/yes/on and false/0/no/off (any case)
 * are accepted; anything else throws so a typo can't silently flip a security-relevant switch.
 */
export function parseBooleanEnv(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new Error(`${name} must be true or false`);
}

/** Lifetime of web → API access tokens. Both sides validate against this one range. */
export const API_TOKEN_TTL = { defaultSeconds: 900, minSeconds: 60, maxSeconds: 3600 } as const;

export function parseApiTokenTtl(value: string | undefined): number {
  const v = value?.trim();
  if (v === undefined || v === '') return API_TOKEN_TTL.defaultSeconds;
  const n = Number(v);
  if (!Number.isInteger(n) || n < API_TOKEN_TTL.minSeconds || n > API_TOKEN_TTL.maxSeconds) {
    throw new Error(
      `API_TOKEN_TTL_SECONDS must be an integer between ${API_TOKEN_TTL.minSeconds} and ${API_TOKEN_TTL.maxSeconds}`,
    );
  }
  return n;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** STAFF_EMAIL_DOMAIN: unset or blank → the default; otherwise a lower-cased domain. */
export function parseStaffEmailDomain(value: string | undefined): string {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return DEFAULT_STAFF_EMAIL_DOMAIN;
  if (!DOMAIN.test(v)) throw new Error('STAFF_EMAIL_DOMAIN must be a domain like example.com');
  return v;
}

/** Placeholder secrets shipped in .env.example must never be used. */
export function isPlaceholderSecret(value: string | undefined): boolean {
  const v = value?.trim() ?? '';
  return v === '' || /replace-?me|changeme|placeholder|example/i.test(v);
}
