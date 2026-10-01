import { describe, expect, it, vi } from 'vitest';
import {
  bustConfigCache,
  e2eConfigKeyWhere,
  isE2eConfigKey,
  isE2eHelpArticleKey,
} from './e2e-config.ts';

describe('E2E config rows (cleanup-e2e, Phase 4 admin spec)', () => {
  it('matches only keys the admin spec generates', () => {
    for (const key of ['e2e-1790000000000', 'e2e-1790000000000-panel']) {
      expect(isE2eConfigKey(key), key).toBe(true);
    }
    for (const key of ['e2e-', 'cyber', 'x-e2e-1', 'e2e_1', 'E2E-1']) {
      expect(isE2eConfigKey(key), key).toBe(false);
    }
    // Keys generated from admin labels such as "E2E encryption notice" are never the suite's
    // (review api-setup-1), nor other shapes around the timestamp.
    for (const key of [
      'e2e-encryption-notice',
      'e2e-monitoring',
      'e2e-encryption',
      'e2e-1',
      'e2e-179000000000',
      'e2e-17900000000000',
      'e2e-1790000000000-macro',
      'e2e-1790000000000-panel-2',
      'e2e-1790000000000-2',
    ]) {
      expect(isE2eConfigKey(key), key).toBe(false);
    }
    expect(e2eConfigKeyWhere()).toEqual({ key: { startsWith: 'e2e-' } });
  });

  it('help articles: only the exact `e2e-<13 digits>` key the Phase 5 spec publishes', () => {
    expect(isE2eHelpArticleKey('e2e-1790000000000')).toBe(true);
    for (const key of [
      'e2e-1790000000000-panel', // a Phase 4 custom-field shape, never an article's
      'e2e-1790000000000-2',
      'e2e-179000000000',
      'e2e-17900000000000',
      'e2e-encryption',
      'e2e-',
      'E2E-1790000000000',
      'x-e2e-1790000000000',
      'report-critical-security-incident',
    ]) {
      expect(isE2eHelpArticleKey(key), key).toBe(false);
    }
  });

  it('busts the config cache like an admin change: generation first, then the cached entries', async () => {
    const calls: string[] = [];
    const multi = {
      incr: vi.fn((key: string) => calls.push(`incr ${key}`)),
      del: vi.fn((...keys: string[]) => calls.push(`del ${keys.join(' ')}`)),
      exec: vi.fn(async () => []),
    };
    await bustConfigCache({ multi: () => multi });
    expect(calls).toEqual([
      'incr loons:config:gen',
      'del loons:config:ticket-form loons:config:sla-calendar',
    ]);
    expect(multi.exec).toHaveBeenCalledOnce();
  });
});
