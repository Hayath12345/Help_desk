import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWebEnvAtStartup } from './startup';

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'replace-me-with-32+-random-bytes');
  vi.stubEnv('API_JWT_SECRET', 'jwt-secret-for-tests-0123456789-abcdef');
  vi.stubEnv('INTERNAL_API_KEY', 'internal-key-for-tests-0123456789-abcdef');
  vi.stubEnv('API_INTERNAL_URL', 'http://api.test');
  vi.stubEnv('API_JWT_ISSUER', 'loons-web');
  vi.stubEnv('API_JWT_AUDIENCE', 'loons-api');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('checkWebEnvAtStartup (SEC-9)', () => {
  it('stops a production server that still uses a placeholder secret', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit called');
    }) as never);
    expect(() => checkWebEnvAtStartup()).toThrow('exit called');
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/AUTH_SECRET still has/));
  });

  it('fails loudly in development too (every request errors until .env is fixed)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const exit = vi.spyOn(process, 'exit');
    expect(() => checkWebEnvAtStartup()).toThrow(/AUTH_SECRET still has the placeholder/);
    expect(exit).not.toHaveBeenCalled();
  });

  it('passes with real secrets', () => {
    vi.stubEnv('AUTH_SECRET', 'auth-secret-for-tests-0123456789-abcdef');
    expect(() => checkWebEnvAtStartup()).not.toThrow();
  });
});
