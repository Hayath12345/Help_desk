// Server-side configuration for authentication and web → API calls.
// Values are read on every call (cheap) so tests can stub them. assertWebEnv() checks everything
// once at server start (instrumentation.ts); every accessor also fails loudly on a bad value, so a
// misconfiguration can never be silently replaced by a default.
import 'server-only';
import {
  isPlaceholderSecret,
  parseApiTokenTtl,
  parseBooleanEnv,
  parseStaffEmailDomain,
} from '@loons/shared';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const MIN_SECRET_LENGTH = 32;

/**
 * A secret that must be real: set, not the .env.example placeholder, and at least 32 characters.
 * Enforced in every environment (a placeholder AUTH_SECRET lets anyone forge a session cookie).
 */
function requiredSecret(name: string): string {
  const value = required(name);
  if (isPlaceholderSecret(value)) {
    throw new Error(
      `${name} still has the placeholder value from .env.example; generate a real secret`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** API base URL as seen from the web server. */
export function apiInternalUrl(): string {
  return stripTrailingSlash(required('API_INTERNAL_URL'));
}

/** Shared key for /internal/* API routes. Never sent to browsers. */
export function internalApiKey(): string {
  return requiredSecret('INTERNAL_API_KEY');
}

/**
 * Secrets that encrypt the Auth.js session cookie: AUTH_SECRET plus the optional rotation
 * secrets AUTH_SECRET_1..3 that Auth.js also reads.
 */
export function authSecrets(): string[] {
  const secrets = [requiredSecret('AUTH_SECRET')];
  for (const name of ['AUTH_SECRET_1', 'AUTH_SECRET_2', 'AUTH_SECRET_3']) {
    if (process.env[name]?.trim()) secrets.push(requiredSecret(name));
  }
  return secrets;
}

export interface ApiTokenConfig {
  secret: Uint8Array;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

/** Settings for the short-lived HS256 access tokens the web server mints for the API. */
export function apiTokenConfig(): ApiTokenConfig {
  return {
    secret: new TextEncoder().encode(requiredSecret('API_JWT_SECRET')),
    issuer: required('API_JWT_ISSUER'),
    audience: required('API_JWT_AUDIENCE'),
    // Same range as the API (@loons/shared); an out-of-range value throws instead of falling back.
    ttlSeconds: parseApiTokenTtl(process.env.API_TOKEN_TTL_SECONDS),
  };
}

/**
 * Seeded staff may sign in with a password — development only, never in production. Parsed like
 * the API parses it (true/1/yes/on); an unrecognised value throws.
 */
export function isDevStaffLoginEnabled(): boolean {
  const enabled = parseBooleanEnv('AUTH_DEV_STAFF_LOGIN', process.env.AUTH_DEV_STAFF_LOGIN, false);
  return enabled && process.env.NODE_ENV !== 'production';
}

export function isGoogleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim());
}

// ── Microsoft Entra ID ──────────────────────────────────────────────────────

const ENTRA_ISSUER =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0\/?$/i;

export interface EntraConfig {
  /** Directory (tenant) id, lower-case GUID. Only accounts of this tenant may sign in. */
  tenantId: string;
  /** Canonical issuer, exactly as the tenant's OpenID discovery document states it. */
  issuer: string;
}

/**
 * Parses AUTH_MICROSOFT_ENTRA_ID_ISSUER. Only a tenant-specific v2.0 issuer
 * (https://login.microsoftonline.com/<tenant-guid>/v2.0) is accepted: `common`, `organizations`
 * and `consumers` would let accounts from any Microsoft tenant (or personal accounts) sign in.
 */
export function parseEntraIssuer(value: string | undefined): EntraConfig | { error: string } {
  const raw = value?.trim() ?? '';
  const match = ENTRA_ISSUER.exec(raw);
  if (!match?.[1]) {
    return {
      error: raw
        ? `AUTH_MICROSOFT_ENTRA_ID_ISSUER must be https://login.microsoftonline.com/<tenant-id-guid>/v2.0 (got "${raw}"; common, organizations and consumers are not allowed)`
        : 'AUTH_MICROSOFT_ENTRA_ID_ISSUER is required: https://login.microsoftonline.com/<tenant-id-guid>/v2.0',
    };
  }
  const tenantId = match[1].toLowerCase();
  return { tenantId, issuer: `https://login.microsoftonline.com/${tenantId}/v2.0` };
}

let reportedEntraProblem: string | null = null;

/**
 * Entra ID staff sign-in settings, or null when it is not configured. Client id + secret without a
 * valid tenant issuer counts as NOT configured (the staff page shows "not set up") and is logged.
 */
export function entraConfig(): EntraConfig | null {
  const hasClient = Boolean(
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() &&
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET?.trim(),
  );
  if (!hasClient) return null;
  const parsed = parseEntraIssuer(process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER);
  if ('error' in parsed) {
    if (reportedEntraProblem !== parsed.error) {
      reportedEntraProblem = parsed.error;
      console.error(`[auth] Microsoft Entra ID sign-in is DISABLED: ${parsed.error}`);
    }
    return null;
  }
  return parsed;
}

export function isEntraConfigured(): boolean {
  return entraConfig() !== null;
}

/** Whether an Entra ID token's `tid` (tenant id) claim is the configured tenant. */
export function isFromEntraTenant(tid: unknown, config: EntraConfig | null): boolean {
  return config !== null && typeof tid === 'string' && tid.toLowerCase() === config.tenantId;
}

// ── Misc ────────────────────────────────────────────────────────────────────

/** The staff email domain (blank → the default); an invalid domain throws. */
export function staffEmailDomain(): string {
  return parseStaffEmailDomain(process.env.STAFF_EMAIL_DOMAIN);
}

const MAX_PROXY_HOPS = 10;

/**
 * Number of reverse proxies in front of the web app that APPEND to X-Forwarded-For (1 = one AWS
 * ALB, the default). The client IP is read that many entries from the right.
 *
 * 0 = nothing in front of Next.js (development only). Next.js only fills X-Forwarded-For in when
 * the request has none, so a client could then choose its own "IP": the web app treats the address
 * as unknown and sends no `x-client-ip`, and the API skips its per-IP sign-in limits (per-email,
 * per-account and global limits still apply). Refused when NODE_ENV=production (RR-SEC-2).
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_PROXY_HOPS) {
    throw new Error(`TRUSTED_PROXY_HOPS must be an integer from 0 to ${MAX_PROXY_HOPS}`);
  }
  if (hops === 0 && process.env.NODE_ENV === 'production') {
    throw new Error(
      'TRUSTED_PROXY_HOPS=0 is not allowed in production: without a proxy that appends the client address to X-Forwarded-For, per-IP sign-in limits cannot apply (set the number of proxies in front of the web app, e.g. 1 for one AWS ALB)',
    );
  }
  return hops;
}

/** Show development-only hints (demo accounts) outside production builds. */
export function isDevelopmentBuild(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Validates the whole web configuration and throws ONE error listing every problem. Runs once at
 * server start (instrumentation.ts) in every environment, so placeholder secrets or invalid values
 * stop the server instead of surfacing later (or silently falling back to defaults).
 */
export function assertWebEnv(): void {
  const checks: (() => unknown)[] = [
    authSecrets,
    internalApiKey,
    apiInternalUrl,
    apiTokenConfig,
    isDevStaffLoginEnabled,
    staffEmailDomain,
    trustedProxyHops,
  ];
  const problems: string[] = [];
  for (const check of checks) {
    try {
      check();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  const unique = new Set(
    ['AUTH_SECRET', 'API_JWT_SECRET', 'INTERNAL_API_KEY'].map((name) => process.env[name]?.trim()),
  );
  if (unique.size < 3 && !problems.length) {
    problems.push(
      'AUTH_SECRET, API_JWT_SECRET and INTERNAL_API_KEY must be three different secrets',
    );
  }
  if (problems.length) {
    throw new Error(`Invalid web configuration:\n  - ${problems.join('\n  - ')}`);
  }
  // Not fatal (staff sign-in is simply disabled), but reported at start-up.
  entraConfig();
}
