import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiTokenConfig,
  assertWebEnv,
  authSecrets,
  entraConfig,
  internalApiKey,
  isDevStaffLoginEnabled,
  isEntraConfigured,
  isFromEntraTenant,
  parseEntraIssuer,
  staffEmailDomain,
  trustedProxyHops,
} from './env';

const PLACEHOLDER = 'replace-me-with-32+-random-bytes';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';

/** A valid configuration; each test breaks one thing. */
function stubValidEnv() {
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(20) + 'auth-secret-0123456789');
  vi.stubEnv('API_JWT_SECRET', 'b'.repeat(20) + 'jwt-secret-0123456789');
  vi.stubEnv('INTERNAL_API_KEY', 'c'.repeat(20) + 'internal-key-0123456789');
  vi.stubEnv('API_INTERNAL_URL', 'http://localhost:4000/');
  vi.stubEnv('API_JWT_ISSUER', 'loons-web');
  vi.stubEnv('API_JWT_AUDIENCE', 'loons-api');
  vi.stubEnv('API_TOKEN_TTL_SECONDS', '900');
  vi.stubEnv('AUTH_DEV_STAFF_LOGIN', 'true');
  vi.stubEnv('STAFF_EMAIL_DOMAIN', 'loonsgroup.com');
  vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
  vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', '');
  vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_SECRET', '');
  vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', '');
  vi.stubEnv('AUTH_SECRET_1', '');
}

beforeEach(stubValidEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('placeholder secrets (SEC-9)', () => {
  it('accepts real secrets', () => {
    expect(() => assertWebEnv()).not.toThrow();
    expect(authSecrets()).toHaveLength(1);
  });

  it.each(['AUTH_SECRET', 'API_JWT_SECRET', 'INTERNAL_API_KEY'])(
    'refuses the .env.example placeholder for %s in every environment',
    (name) => {
      for (const nodeEnv of ['development', 'test', 'production']) {
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.stubEnv(name, PLACEHOLDER);
        expect(() => assertWebEnv()).toThrow(new RegExp(`${name} still has the placeholder`));
      }
    },
  );

  it('refuses missing and short secrets', () => {
    vi.stubEnv('AUTH_SECRET', '');
    vi.stubEnv('INTERNAL_API_KEY', 'short-but-real');
    expect(() => assertWebEnv()).toThrow(/AUTH_SECRET[\s\S]*INTERNAL_API_KEY must be at least 32/);
    expect(() => internalApiKey()).toThrow(/at least 32/);
  });

  it('checks rotation secrets too, and requires three different secrets', () => {
    vi.stubEnv('AUTH_SECRET_1', 'changeme-changeme-changeme-changeme');
    expect(() => authSecrets()).toThrow(/AUTH_SECRET_1/);
    vi.stubEnv('AUTH_SECRET_1', '');
    vi.stubEnv('INTERNAL_API_KEY', process.env.API_JWT_SECRET ?? '');
    expect(() => assertWebEnv()).toThrow(/three different secrets/);
  });

  it('lists every problem in one error', () => {
    vi.stubEnv('AUTH_SECRET', PLACEHOLDER);
    vi.stubEnv('API_TOKEN_TTL_SECONDS', '45');
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'two');
    const error = (() => {
      try {
        assertWebEnv();
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toMatch(/AUTH_SECRET/);
    expect(error?.message).toMatch(/API_TOKEN_TTL_SECONDS/);
    expect(error?.message).toMatch(/TRUSTED_PROXY_HOPS/);
  });
});

describe('apiTokenConfig (F7)', () => {
  it('uses the shared TTL range and fails loudly outside it', () => {
    expect(apiTokenConfig().ttlSeconds).toBe(900);
    vi.stubEnv('API_TOKEN_TTL_SECONDS', '');
    expect(apiTokenConfig().ttlSeconds).toBe(900);
    vi.stubEnv('API_TOKEN_TTL_SECONDS', '60');
    expect(apiTokenConfig().ttlSeconds).toBe(60);
    for (const bad of ['45', '3601', '999999', '12.5', 'soon']) {
      vi.stubEnv('API_TOKEN_TTL_SECONDS', bad);
      expect(() => apiTokenConfig()).toThrow(/API_TOKEN_TTL_SECONDS/);
    }
  });
});

describe('isDevStaffLoginEnabled (AUTH-1)', () => {
  it('reads the flag like the API does', () => {
    for (const on of ['true', 'TRUE', ' 1 ', 'yes', 'on']) {
      vi.stubEnv('AUTH_DEV_STAFF_LOGIN', on);
      expect(isDevStaffLoginEnabled()).toBe(true);
    }
    for (const off of ['false', '0', 'no', 'off', '']) {
      vi.stubEnv('AUTH_DEV_STAFF_LOGIN', off);
      expect(isDevStaffLoginEnabled()).toBe(false);
    }
  });

  it('throws on a typo instead of silently disabling the flag', () => {
    vi.stubEnv('AUTH_DEV_STAFF_LOGIN', 'ture');
    expect(() => isDevStaffLoginEnabled()).toThrow(/AUTH_DEV_STAFF_LOGIN/);
  });

  it('is always off in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isDevStaffLoginEnabled()).toBe(false);
  });
});

describe('staffEmailDomain', () => {
  it('treats blank as the default and rejects junk', () => {
    vi.stubEnv('STAFF_EMAIL_DOMAIN', '  ');
    expect(staffEmailDomain()).toBe('loonsgroup.com');
    vi.stubEnv('STAFF_EMAIL_DOMAIN', 'Loons.Example.COM');
    expect(staffEmailDomain()).toBe('loons.example.com');
    vi.stubEnv('STAFF_EMAIL_DOMAIN', 'not a domain');
    expect(() => staffEmailDomain()).toThrow(/STAFF_EMAIL_DOMAIN/);
  });
});

describe('trustedProxyHops (SEC-6)', () => {
  it('defaults to one appending proxy', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    expect(trustedProxyHops()).toBe(1);
  });

  it('accepts 0 (nothing in front of Next.js) up to 10', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
    expect(trustedProxyHops()).toBe(0);
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    expect(trustedProxyHops()).toBe(2);
  });

  it('fails loudly on anything else', () => {
    for (const bad of ['-1', '11', '1.5', 'one']) {
      vi.stubEnv('TRUSTED_PROXY_HOPS', bad);
      expect(() => trustedProxyHops()).toThrow(/TRUSTED_PROXY_HOPS/);
    }
  });
});

describe('Microsoft Entra ID tenant restriction (SEC-3)', () => {
  it('accepts only a tenant-GUID v2.0 issuer and canonicalises it', () => {
    for (const issuer of [
      `https://login.microsoftonline.com/${TENANT}/v2.0`,
      `https://login.microsoftonline.com/${TENANT}/v2.0/`,
      `https://login.microsoftonline.com/${TENANT.toUpperCase()}/v2.0`,
    ]) {
      expect(parseEntraIssuer(issuer)).toEqual({
        tenantId: TENANT,
        issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      });
    }
  });

  it.each([
    'https://login.microsoftonline.com/common/v2.0',
    'https://login.microsoftonline.com/organizations/v2.0/',
    'https://login.microsoftonline.com/consumers/v2.0',
    `https://login.microsoftonline.com/${TENANT}`,
    `https://login.microsoftonline.com/${TENANT}/v2.0/extra`,
    `http://login.microsoftonline.com/${TENANT}/v2.0`,
    `https://evil.example/${TENANT}/v2.0`,
    'loonsgroup.onmicrosoft.com',
    '',
  ])('rejects %j', (issuer) => {
    expect(parseEntraIssuer(issuer)).toHaveProperty('error');
  });

  it('enables the provider only with a client id, secret AND tenant issuer', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ID', 'client-id');
    vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_SECRET', 'client-secret');

    vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', 'https://login.microsoftonline.com/common/v2.0');
    expect(isEntraConfigured()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Entra ID sign-in is DISABLED.*common/));

    vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', '');
    expect(entraConfig()).toBeNull();

    vi.stubEnv(
      'AUTH_MICROSOFT_ENTRA_ID_ISSUER',
      `https://login.microsoftonline.com/${TENANT}/v2.0/`,
    );
    expect(entraConfig()).toEqual({
      tenantId: TENANT,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    });
  });

  it('accepts only ID tokens whose tid is the configured tenant', () => {
    const config = { tenantId: TENANT, issuer: `https://login.microsoftonline.com/${TENANT}/v2.0` };
    expect(isFromEntraTenant(TENANT, config)).toBe(true);
    expect(isFromEntraTenant(TENANT.toUpperCase(), config)).toBe(true);
    expect(isFromEntraTenant('9188040d-6c67-4c5b-b112-36a304b66dad', config)).toBe(false);
    expect(isFromEntraTenant(42, config)).toBe(false);
    expect(isFromEntraTenant(undefined, config)).toBe(false);
    expect(isFromEntraTenant(TENANT, null)).toBe(false);
  });

  it('is simply off (no error) without a client id and secret', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('AUTH_MICROSOFT_ENTRA_ID_ISSUER', 'https://login.microsoftonline.com/common/v2.0');
    expect(isEntraConfigured()).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
