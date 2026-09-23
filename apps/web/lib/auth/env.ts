// Server-side configuration for authentication and web → API calls.
// Values are read on every call (cheap) so tests can stub them and misconfiguration fails loudly
// at the first request instead of at build time.
import 'server-only';
import { DEFAULT_STAFF_EMAIL_DOMAIN } from '@loons/shared';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
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
  return required('INTERNAL_API_KEY');
}

export interface ApiTokenConfig {
  secret: Uint8Array;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_TTL_SECONDS = 900;

/** Settings for the short-lived HS256 access tokens the web server mints for the API. */
export function apiTokenConfig(): ApiTokenConfig {
  const secret = required('API_JWT_SECRET');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`API_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const ttlRaw = Number(process.env.API_TOKEN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const ttlSeconds =
    Number.isInteger(ttlRaw) && ttlRaw >= 60 && ttlRaw <= 3600 ? ttlRaw : DEFAULT_TTL_SECONDS;
  return {
    secret: new TextEncoder().encode(secret),
    issuer: required('API_JWT_ISSUER'),
    audience: required('API_JWT_AUDIENCE'),
    ttlSeconds,
  };
}

/** Seeded staff may sign in with a password — development only, never in production. */
export function isDevStaffLoginEnabled(): boolean {
  return process.env.AUTH_DEV_STAFF_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
}

export function isGoogleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim());
}

export function isEntraConfigured(): boolean {
  return Boolean(
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() &&
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET?.trim(),
  );
}

export function staffEmailDomain(): string {
  return (process.env.STAFF_EMAIL_DOMAIN?.trim() || DEFAULT_STAFF_EMAIL_DOMAIN).toLowerCase();
}

/**
 * Number of reverse proxies in front of the web app that append to X-Forwarded-For
 * (1 = e.g. one AWS ALB, or none: Next.js fills the header from the socket). Default 1.
 */
export function trustedProxyHops(): number {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(hops) && hops >= 1 && hops <= 10 ? hops : 1;
}

/** Show development-only hints (demo accounts) outside production builds. */
export function isDevelopmentBuild(): boolean {
  return process.env.NODE_ENV !== 'production';
}
