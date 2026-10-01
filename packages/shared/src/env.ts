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

/**
 * Largest number of reverse proxies the API (TRUST_PROXY) and the web app (TRUSTED_PROXY_HOPS) accept
 * in front of them. One ALB is 1, CloudFront in front of an ALB is 2, a WAF/ALB chain behind it 3;
 * anything above that means a typo or a client-controlled X-Forwarded-For entry would be trusted.
 */
export const MAX_TRUSTED_PROXY_HOPS = 3;

/**
 * Whether the process runs on an AWS container runtime: ECS (Fargate and EC2) sets
 * `ECS_CONTAINER_METADATA_URI_V4` / `ECS_CONTAINER_METADATA_URI` for every container, and the
 * Lambda / Fargate / CodeBuild runtimes set `AWS_EXECUTION_ENV`. Used to refuse developer-machine
 * settings (NODE_ENV=development, DEPLOY_PROFILE=rehearsal) where they would silently switch the
 * production safety rules off.
 */
export function runsOnAwsRuntime(env: Record<string, string | undefined>): boolean {
  return ['AWS_EXECUTION_ENV', 'ECS_CONTAINER_METADATA_URI_V4', 'ECS_CONTAINER_METADATA_URI'].some(
    (name) => (env[name]?.trim() ?? '') !== '',
  );
}

/**
 * Settings that only make sense on a developer machine, refused when the process runs on an AWS
 * container runtime (see `runsOnAwsRuntime`): NODE_ENV other than production (unset counts as
 * production) and DEPLOY_PROFILE=rehearsal would switch every production rule off. Runs in every
 * environment; the API, the worker and the web server all call it with `process.env`.
 */
export function awsRuntimeProblems(env: Record<string, string | undefined>): string[] {
  if (!runsOnAwsRuntime(env)) return [];
  const problems: string[] = [];
  const nodeEnv = env.NODE_ENV?.trim() ?? '';
  if (nodeEnv !== '' && nodeEnv !== 'production') {
    problems.push(
      'NODE_ENV must be production on AWS (an AWS runtime was detected): development / test switch the production rules off',
    );
  }
  if (env.DEPLOY_PROFILE?.trim().toLowerCase() === 'rehearsal') {
    problems.push(
      'DEPLOY_PROFILE must be aws on AWS (an AWS runtime was detected): rehearsal exists for the local docker-compose rehearsal only',
    );
  }
  return problems;
}

/**
 * Whether a URL host name (`URL.hostname`: lower-cased, IPv6 in brackets, IPv4 already in dotted
 * form) is this machine: `localhost` and `*.localhost`, all of 127.0.0.0/8 and 0.0.0.0/8, `::1`, `::`
 * and their IPv4-mapped forms. A public address is never one of these.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) return v4[1] === '127' || v4[1] === '0';
  const v6 = /^\[(.*)\]$/.exec(host)?.[1];
  if (v6 === undefined) return false;
  if (v6 === '::1' || v6 === '::') return true;
  // IPv4-mapped (::ffff:7f00:1 is 127.0.0.1): the high byte of the first group is the first octet.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(v6);
  if (mapped) {
    const firstOctet = parseInt(mapped[1]!, 16) >> 8;
    return firstOctet === 127 || firstOctet === 0;
  }
  return false;
}
