// Production-only configuration rules (Phase 6, decision G6).
//
// When NODE_ENV=production and DEPLOY_PROFILE=aws (the default: unset means the strict profile),
// the API and the worker refuse to start on a setting that is only acceptable on a developer
// machine: plain-HTTP URLs, an unencrypted database or Redis connection, MinIO / static S3 keys,
// the SMTP / console providers, an unset proxy trust, or the Socket.IO Redis adapter switched off
// (a deployment may scale the API past one task at any time, so it is always required).
// DEPLOY_PROFILE=rehearsal switches these rules off so the same images can run against the local docker-compose services (docker-compose.prod.yml, scripts/smoke-prod.sh);
// it logs a warning at start-up and must never be set on AWS.
//
// Messages name the variables, never their values (a URL can carry a password).

import { isLocalHostname } from '@loons/shared';

/** Which production rule set applies (DEPLOY_PROFILE). */
export const DEPLOY_PROFILES = ['aws', 'rehearsal'] as const;
export type DeployProfile = (typeof DEPLOY_PROFILES)[number];

/** What the production rules look at (already parsed by the environment schema). */
export interface ProductionRuleInput {
  appUrl: string;
  corsOrigins: string[];
  databaseUrl: string;
  redisUrl: string;
  socketRedisAdapter: boolean;
  trustProxyConfigured: boolean;
  s3: {
    region: string;
    endpoint: string | undefined;
    forcePathStyle: boolean;
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
  };
  emailProvider: string;
  smsProvider: string;
  teamsProvider: string;
  sesRegion: string | undefined;
  snsRegion: string | undefined;
}

/** `me-central-1`, `eu-west-1`, `us-gov-east-1` … */
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
/**
 * The only `sslmode` accepted: certificate and host name are verified. node-postgres still treats
 * `require` / `verify-ca` as aliases of it but warns that its next major version gives them the weaker
 * libpq meaning (encrypt without verifying), so they are refused rather than relied on.
 */
const VERIFIED_TLS = 'verify-full';

function isHttpsNonLocal(value: string): 'ok' | 'not-https' | 'local' {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not-https';
  }
  if (url.protocol !== 'https:') return 'not-https';
  return isLocalHostname(url.hostname) ? 'local' : 'ok';
}

/**
 * Every `sslmode` parameter of a PostgreSQL URL (none when the URL does not parse). node-postgres
 * applies the LAST one when a name is repeated while `URLSearchParams.get` returns the first, so a
 * URL carrying two values cannot be judged by looking at one of them.
 */
export function databaseSslModes(databaseUrl: string): string[] {
  try {
    return new URL(databaseUrl).searchParams.getAll('sslmode').map((v) => v.toLowerCase());
  } catch {
    return [];
  }
}

/** The `sslmode` of a PostgreSQL URL, or null when there is none, exactly one is not given, or the URL does not parse. */
export function databaseSslMode(databaseUrl: string): string | null {
  const modes = databaseSslModes(databaseUrl);
  return modes.length === 1 ? modes[0]! : null;
}

/** A `<...>` template placeholder or a "replace-me" left in a connection string. */
function hasPlaceholder(value: string): boolean {
  return /[<>]|replace-?me/i.test(value);
}

/**
 * Whether the user name / password part of a connection URL needs percent-encoding: anything
 * outside the characters RFC 3986 allows in user information (so a password containing / ? # @ [ ]
 * < > a space or a bare % would otherwise end the user information early or break the URL), or a
 * % that does not start a %XX escape. The part is everything before the LAST @.
 */
function credentialsNeedEncoding(url: string): boolean {
  const userInfo = /^[a-z][a-z0-9+.-]*:\/\/(.*)@/i.exec(url)?.[1];
  if (userInfo === undefined) return false;
  return /[^A-Za-z0-9\-._~!$&'()*+,;=:%]/.test(userInfo) || /%(?![0-9A-Fa-f]{2})/.test(userInfo);
}

/**
 * The reasons a connection URL (DATABASE_URL / REDIS_URL) cannot be used as written, or [] when it
 * has none of them. Only the variable name is reported, never the URL.
 */
function connectionUrlProblems(name: string, value: string): string[] {
  if (hasPlaceholder(value)) {
    return [
      `${name} still contains a placeholder (<...> or replace-me): put the real endpoint and credentials in`,
    ];
  }
  if (credentialsNeedEncoding(value)) {
    return [
      `${name} has a user name or password with characters that must be percent-encoded (@ / ? # % [ ] < > space ...: write # as %23, @ as %40, / as %2F); or use an alphanumeric password`,
    ];
  }
  return [];
}

/** Problems with a configuration that is about to serve production traffic on AWS. */
export function productionProblems(input: ProductionRuleInput): string[] {
  const problems: string[] = [];

  const app = isHttpsNonLocal(input.appUrl);
  if (app === 'not-https') problems.push('APP_URL must be an https:// URL in production');
  if (app === 'local') problems.push('APP_URL must not point at localhost in production');
  if (!input.corsOrigins.every((origin) => isHttpsNonLocal(origin) === 'ok')) {
    problems.push('CORS_ORIGINS must list https:// origins (not localhost) in production');
  }

  const databaseProblems = connectionUrlProblems('DATABASE_URL', input.databaseUrl);
  problems.push(...databaseProblems);
  if (databaseProblems.length === 0) {
    const sslModes = databaseSslModes(input.databaseUrl);
    if (sslModes.length > 1) {
      problems.push('DATABASE_URL must carry exactly one sslmode parameter (sslmode=verify-full)');
    } else if (sslModes[0] !== VERIFIED_TLS) {
      problems.push(
        'DATABASE_URL must use verified TLS in production: add sslmode=verify-full (and sslrootcert=<RDS CA bundle>)',
      );
    }
  }
  const redisProblems = connectionUrlProblems('REDIS_URL', input.redisUrl);
  problems.push(...redisProblems);
  if (redisProblems.length === 0 && !input.redisUrl.toLowerCase().startsWith('rediss://')) {
    problems.push('REDIS_URL must use TLS (rediss://) in production');
  }

  // Always required on AWS: a service can be scaled past one API task at any time (autoscaling,
  // a console change), and without the adapter events only reach users connected to the same task.
  if (!input.socketRedisAdapter) {
    problems.push(
      'SOCKET_REDIS_ADAPTER must be true in production (events would not reach users connected to another API task)',
    );
  }
  if (!input.trustProxyConfigured) {
    problems.push(
      'TRUST_PROXY must be set in production (1 behind one load balancer, or the proxy IPs / CIDRs): without it every client shares the load balancer address',
    );
  }

  if (input.s3.endpoint) {
    problems.push('S3_ENDPOINT must be empty in production (AWS S3 is addressed by region)');
  }
  if (input.s3.forcePathStyle) problems.push('S3_FORCE_PATH_STYLE must be false in production');
  if (input.s3.accessKeyId || input.s3.secretAccessKey) {
    problems.push(
      'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be empty in production (use the task / pod IAM role)',
    );
  }

  if (input.emailProvider !== 'ses') problems.push('EMAIL_PROVIDER must be ses in production');
  if (input.smsProvider !== 'sns') problems.push('SMS_PROVIDER must be sns in production');
  if (input.teamsProvider !== 'webhook')
    problems.push('TEAMS_PROVIDER must be webhook in production');

  const regions: [string, string | undefined][] = [
    ['S3_REGION', input.s3.region],
    ['SES_REGION', input.sesRegion],
    ['SNS_REGION', input.snsRegion],
  ];
  for (const [name, region] of regions) {
    if (region !== undefined && !AWS_REGION.test(region)) {
      problems.push(`${name} must be an AWS region such as me-central-1`);
    }
  }
  return problems;
}
