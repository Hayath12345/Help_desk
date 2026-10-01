import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publicUrlProblems } from './docker-check-build-args';

const good = {
  NEXT_PUBLIC_API_URL: 'https://api.help.example.com',
  NEXT_PUBLIC_UPLOAD_ORIGIN: 'https://loons-helpdesk-attachments.s3.me-central-1.amazonaws.com',
};

describe('publicUrlProblems (web image build arguments)', () => {
  it('accepts two https addresses of real hosts', () => {
    expect(publicUrlProblems(good)).toEqual([]);
  });

  it('requires both', () => {
    expect(publicUrlProblems({})).toEqual([
      'NEXT_PUBLIC_API_URL build argument is required',
      'NEXT_PUBLIC_UPLOAD_ORIGIN build argument is required',
    ]);
    expect(publicUrlProblems({ ...good, NEXT_PUBLIC_API_URL: '  ' })).toEqual([
      'NEXT_PUBLIC_API_URL build argument is required',
    ]);
  });

  it('refuses plain http, localhost in every spelling, and things that are not URLs', () => {
    expect(
      publicUrlProblems({ ...good, NEXT_PUBLIC_API_URL: 'http://api.help.example.com' }),
    ).toEqual([expect.stringMatching(/^NEXT_PUBLIC_API_URL must be an https:\/\/ URL/)]);
    for (const host of [
      'localhost:4000',
      '127.0.0.1',
      '127.0.0.2',
      '[::1]',
      '0.0.0.0',
      'a.localhost',
    ]) {
      expect(
        publicUrlProblems({ ...good, NEXT_PUBLIC_UPLOAD_ORIGIN: `https://${host}` }),
        host,
      ).toEqual([expect.stringMatching(/^NEXT_PUBLIC_UPLOAD_ORIGIN must not point at localhost/)]);
    }
    for (const bad of ['api.help.example.com', 'ftp://x.example.com', 'https://']) {
      expect(publicUrlProblems({ ...good, NEXT_PUBLIC_API_URL: bad }), bad).toEqual([
        expect.stringMatching(/^NEXT_PUBLIC_API_URL must be an http\(s\) URL/),
      ]);
    }
  });

  it('REHEARSAL_BUILD=true allows http and localhost (docker-compose.prod.yml), but still needs a URL', () => {
    const rehearsal = {
      REHEARSAL_BUILD: 'true',
      NEXT_PUBLIC_API_URL: 'http://localhost:4100',
      NEXT_PUBLIC_UPLOAD_ORIGIN: 'http://localhost:9000',
    };
    expect(publicUrlProblems(rehearsal)).toEqual([]);
    expect(publicUrlProblems({ ...rehearsal, NEXT_PUBLIC_API_URL: '' })).toHaveLength(1);
    expect(publicUrlProblems({ ...rehearsal, NEXT_PUBLIC_API_URL: 'nonsense' })).toHaveLength(1);
    // Only the exact value "true" counts.
    expect(publicUrlProblems({ ...rehearsal, REHEARSAL_BUILD: 'yes' })).toHaveLength(2);
  });
});

describe('docker-check-build-args.ts as the Dockerfile runs it', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['docker-check-build-args.ts'], {
      cwd: import.meta.dirname,
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...env },
      encoding: 'utf8',
    });

  it('exits 0 for good arguments and 1 with a [build] line for bad ones', () => {
    expect(run(good).status).toBe(0);
    const bad = run({ ...good, NEXT_PUBLIC_API_URL: 'http://localhost:4000' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/^\[build\] NEXT_PUBLIC_API_URL must be an https:\/\/ URL/m);
    expect(run({}).status).toBe(1);
  });

  it('the Dockerfile runs it before `next build`, and compose passes the rehearsal switch', () => {
    const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^ARG REHEARSAL_BUILD=false$/m);
    const check = dockerfile.indexOf('node docker-check-build-args.ts');
    const build = dockerfile.indexOf('pnpm exec next build');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(build);
    const compose = readFileSync(new URL('../../docker-compose.prod.yml', import.meta.url), 'utf8');
    expect(compose).toMatch(/REHEARSAL_BUILD: 'true'/);
  });
});
