// The production variable list cannot drift (Phase 6, tests: "Docs"). Three things describe the
// environment of a deployment - the code that reads it, `.env.production.example` and the table
// in docs/DEPLOYMENT.md - and this test fails when they stop agreeing:
//  - every variable the API / worker reads is documented in the example, and every variable the
//    example attributes to them exists in config.ts;
//  - the same for the web app (found by reading its source) and the seed;
//  - the example, with its placeholders filled in, is a configuration the strict production
//    rules accept, and unchanged it is refused (a template cannot be deployed as it is);
//  - the secret / plain / build classification and the web image's build arguments match the table.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, ENV_VARIABLES, loadConfig } from './config.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const COMPONENTS = ['web', 'api', 'worker', 'migrate'] as const;
const KINDS = ['secret', 'plain', 'build'] as const;
type Component = (typeof COMPONENTS)[number];
type Kind = (typeof KINDS)[number];

interface Documented {
  name: string;
  components: Component[];
  kind: Kind;
  value: string;
}

/** `.env.production.example` → one entry per variable, with the header line that governs it. */
function parseExample(text: string): Documented[] {
  const found: Documented[] = [];
  let header: { components: Component[]; kind: Kind } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      header = null;
      continue;
    }
    const head = /^# \[([a-z ]+) \| (secret|plain|build)\]/.exec(line);
    if (head) {
      const components = head[1]!.split(' ').filter(Boolean) as Component[];
      for (const c of components) expect(COMPONENTS, `component "${c}"`).toContain(c);
      header = { components, kind: head[2] as Kind };
      continue;
    }
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (assignment) {
      expect(header, `${assignment[1]} has no "# [who | kind]" header line`).not.toBeNull();
      found.push({ name: assignment[1]!, ...header!, value: assignment[2]! });
    }
  }
  return found;
}

const example = parseExample(read('.env.production.example'));
const byName = new Map(example.map((v) => [v.name, v]));

/** The example with every placeholder replaced by a plausible real value (a configuration the strict rules accept). */
function filledExample(): Record<string, string> {
  const filled: Record<string, string> = Object.fromEntries(example.map((v) => [v.name, v.value]));
  return Object.assign(filled, {
    API_JWT_SECRET: 'j'.repeat(43),
    INTERNAL_API_KEY: 'k'.repeat(43),
    DATABASE_URL: filled
      .DATABASE_URL!.replace('replace-me-password', 'pw')
      .replace('<rds-endpoint>', 'loons.abc.me-central-1.rds.amazonaws.com'),
    REDIS_URL: filled
      .REDIS_URL!.replace('replace-me-token', 'tok')
      .replace('<elasticache-primary-endpoint>', 'master.loons.abc.mec1.cache.amazonaws.com'),
  });
}

/** Files of the web app that count as source (not tests, builds or dependencies). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.next', 'e2e', 'test-results', 'generated'].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

/** Environment variables the web app's source reads. */
function webVariables(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(join(root, 'apps/web'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]!);
  }
  // lib/auth/env.ts also reads names through helpers (`required('API_INTERNAL_URL')`, the
  // rotation secrets): its string literals that look like variable names.
  for (const m of read('apps/web/lib/auth/env.ts').matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g)) {
    names.add(m[1]!);
  }
  return names;
}

/** Read by something that is not this code base's own: Node / Next.js / the CI. */
const NOT_OURS = new Set(['CI', 'NEXT_RUNTIME']);
/** Read by libraries, not by this code base: Next.js's standalone server (set by the image) and Auth.js. */
const READ_BY_LIBRARIES = new Set(['PORT', 'HOSTNAME', 'AUTH_TRUST_HOST']);

describe('.env.production.example', () => {
  it('declares every variable once, with a component list and a kind', () => {
    expect(example.length).toBeGreaterThan(50);
    expect(new Set(example.map((v) => v.name)).size).toBe(example.length);
    for (const v of example) {
      expect(v.components.length, v.name).toBeGreaterThan(0);
      expect(KINDS, v.name).toContain(v.kind);
    }
  });

  it('documents every variable the API and the worker read, and only those it attributes to them', () => {
    const apiNames = ENV_VARIABLES.filter((name) => name !== 'npm_package_version');
    for (const name of apiNames) {
      const doc = byName.get(name);
      expect(
        doc,
        `${name} is read by config.ts but missing from .env.production.example`,
      ).toBeDefined();
      expect(
        doc!.components.some((c) => c === 'api' || c === 'worker'),
        `${name} is read by the API but the example does not say api / worker`,
      ).toBe(true);
    }
    for (const v of example) {
      if (v.components.some((c) => c === 'api' || c === 'worker')) {
        expect(
          ENV_VARIABLES,
          `${v.name} is attributed to api / worker but config.ts ignores it`,
        ).toContain(v.name);
      }
    }
  });

  it('lists the worker for every variable whose absence stops the worker (it runs the same configuration check)', () => {
    // worker.ts calls loadConfig(): with a variable removed from a known-good production
    // configuration, a failing check means the worker needs the variable too.
    const filled = filledExample();
    expect(() => loadConfig(filled)).not.toThrow();
    const required: string[] = [];
    for (const name of ENV_VARIABLES) {
      if (name === 'npm_package_version') continue;
      const without = { ...filled };
      delete without[name];
      try {
        loadConfig(without);
      } catch {
        required.push(name);
      }
    }
    // The ones that must be there, so the experiment cannot silently stop finding anything.
    for (const name of [
      'CORS_ORIGINS',
      'API_JWT_SECRET',
      'INTERNAL_API_KEY',
      'TRUST_PROXY',
      'SOCKET_REDIS_ADAPTER',
      'S3_BUCKET',
      'APP_URL',
    ]) {
      expect(required, name).toContain(name);
    }
    const missing = required.filter((name) => !byName.get(name)?.components.includes('worker'));
    expect(
      missing,
      'the worker fails to start without these variables, so "worker" must be among their readers',
    ).toEqual([]);
  });

  it('documents every variable the web app reads, and only existing ones', () => {
    const web = webVariables();
    for (const name of web) {
      if (NOT_OURS.has(name)) continue;
      expect(byName.has(name), `${name} is read by the web app but missing from the example`).toBe(
        true,
      );
    }
    for (const v of example) {
      if (!v.components.includes('web')) continue;
      const known = web.has(v.name) || READ_BY_LIBRARIES.has(v.name);
      expect(known, `${v.name} is attributed to web but the web app never reads it`).toBe(true);
    }
  });

  it('the variables of the migrate image are the ones the seed and Prisma read', () => {
    const seedSources = [
      read('packages/db/prisma/seed.ts'),
      read('packages/db/prisma/seed-data/options.ts'),
      read('packages/db/prisma.config.ts'),
    ].join('\n');
    for (const v of example.filter((entry) => entry.components.includes('migrate'))) {
      expect(
        seedSources,
        `${v.name} is attributed to migrate but the seed never reads it`,
      ).toContain(v.name);
    }
    for (const name of [
      'DATABASE_URL',
      'NODE_ENV',
      'SEED_DEMO_DATA',
      'SEED_ADMIN_EMAIL',
      'STAFF_EMAIL_DOMAIN',
    ]) {
      expect(byName.get(name)?.components, name).toContain('migrate');
    }
  });

  it('holds no real secret: every secret is empty or an obvious placeholder', () => {
    for (const v of example.filter((entry) => entry.kind === 'secret')) {
      expect(v.value === '' || /replace-me|<[^>]+>/.test(v.value), `${v.name}=${v.value}`).toBe(
        true,
      );
    }
    expect(read('.env.production.example')).not.toMatch(/AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}/);
  });

  it('cannot be deployed as it is: the placeholders are refused', () => {
    const raw = Object.fromEntries(example.map((v) => [v.name, v.value]));
    expect(() => loadConfig(raw)).toThrow(ConfigError);
  });

  it('the connection URLs are refused while their <...> / replace-me parts are left in', () => {
    // The secrets check only covers API_JWT_SECRET, INTERNAL_API_KEY (and AUTH_SECRET in the web
    // app); the URLs have their own placeholder check. Fix the secrets, leave the URLs.
    const raw = {
      ...Object.fromEntries(example.map((v) => [v.name, v.value])),
      API_JWT_SECRET: 'j'.repeat(43),
      INTERNAL_API_KEY: 'k'.repeat(43),
    };
    let problems: string[] = [];
    try {
      loadConfig(raw);
    } catch (err) {
      problems = (err as ConfigError).problems;
    }
    expect(problems.filter((p) => /placeholder/.test(p))).toEqual([
      expect.stringMatching(/^DATABASE_URL still contains a placeholder/),
      expect.stringMatching(/^REDIS_URL still contains a placeholder/),
    ]);
  });

  it('writes no value in quotes (they would be copied into the task definition literally)', () => {
    for (const v of example) {
      expect(v.value, v.name).not.toMatch(/^["']|["']$/);
    }
  });

  it('keeps the connection strings usable: percent-encoded credentials survive the config check', () => {
    const filled = filledExample();
    filled.DATABASE_URL = filled.DATABASE_URL!.replace(':pw@', ':p%23w%40%2F@');
    filled.REDIS_URL = filled.REDIS_URL!.replace(':tok@', ':t%3Fok@');
    expect(() => loadConfig(filled)).not.toThrow();
  });

  it('with its placeholders filled in, passes the strict production rules', () => {
    const filled = filledExample();
    const config = loadConfig(filled);
    expect(config).toMatchObject({
      env: 'production',
      deployProfile: 'aws',
      isProduction: true,
      socketRedisAdapter: true,
      trustProxy: 1,
      redisPrefix: 'loons:',
      devStaffLogin: false,
      docsEnabled: false,
    });
    expect(config.email.provider).toBe('ses');
    expect(config.sms.provider).toBe('sns');
    expect(config.teams.provider).toBe('webhook');
    expect(config.s3).toMatchObject({ endpoint: undefined, accessKeyId: undefined });
    expect(config.worker.heartbeatFile).toBe('/tmp/loons-worker-heartbeat');
  });
});

describe('docs/DEPLOYMENT.md and the images', () => {
  const docs = existsSync(join(root, 'docs/DEPLOYMENT.md')) ? read('docs/DEPLOYMENT.md') : '';
  const rows = new Map<string, { components: string; kind: string }>();
  for (const m of docs.matchAll(
    /^\| `([A-Z][A-Z0-9_]*)`\s*\| ([^|]+?)\s*\| (secret|plain|build)\s*\|/gm,
  )) {
    rows.set(m[1]!, { components: m[2]!.trim(), kind: m[3]! });
  }

  it('the environment variable table lists every variable with the same kind', () => {
    expect(docs, 'docs/DEPLOYMENT.md is missing').not.toBe('');
    for (const v of example) {
      const row = rows.get(v.name);
      expect(row, `${v.name} is missing from the table in docs/DEPLOYMENT.md`).toBeDefined();
      expect(row!.kind, `${v.name}: kind differs between the table and the example`).toBe(v.kind);
      expect(row!.components.split(/[ ,]+/).sort(), `${v.name}: readers differ`).toEqual(
        [...v.components].sort(),
      );
    }
    for (const name of rows.keys()) {
      expect(byName.has(name), `${name} is in the table but not in the example`).toBe(true);
    }
  });

  it('the web image takes exactly the build-time variables as build arguments', () => {
    const dockerfile = read('apps/web/Dockerfile');
    const args = [...dockerfile.matchAll(/^ARG (NEXT_PUBLIC_[A-Z_]+)/gm)].map((m) => m[1]!).sort();
    const build = example
      .filter((v) => v.kind === 'build')
      .map((v) => v.name)
      .sort();
    expect(args).toEqual(build);
  });

  it("the migrate image switches off Prisma's version check (checkpoint.prisma.io)", () => {
    const dockerfile = read('apps/api/Dockerfile');
    const migrate = dockerfile.slice(dockerfile.indexOf('AS migrate'));
    expect(migrate).toMatch(/CHECKPOINT_DISABLE=1/);
  });

  it('REQUIRE_RDS_CA demands both CA files, and the example URL names exactly those', () => {
    const dockerfile = read('apps/api/Dockerfile');
    expect(dockerfile).toMatch(/for f in rds-global-bundle\.pem rds-ca\.pem; do/);
    const url = byName.get('DATABASE_URL')!.value;
    expect(url).toContain('sslrootcert=/app/certs/rds-global-bundle.pem');
    expect(url).toContain('sslcert=/app/certs/rds-ca.pem');
    expect(url).toContain('sslaccept=strict');
  });

  it('the guide keeps the operational facts a deployment depends on', () => {
    expect(docs.indexOf('GRANT loons_app TO')).toBeGreaterThan(0);
    expect(docs.indexOf('GRANT loons_app TO')).toBeLessThan(
      docs.indexOf('CREATE DATABASE loons OWNER loons_app'),
    );
    // The load balancer checks liveness; /health is for monitoring.
    expect(docs).toMatch(/ALB target group \*\*`\/health\/live`\*\*/);
    expect(docs).toMatch(/health check \*\*`\/health\/live`\*\*/);
    // The public listener blocks the internal routes and the docs.
    expect(docs).toMatch(/fixed response 403/);
    expect(docs).toContain('`/internal/*`');
    expect(docs).toContain('`/docs*`');
    // The migrate task starts like every other task: 443 egress.
    expect(docs).toMatch(/\| `sg-migrate`[^\n]*443 like the other tasks/);
    expect(docs).not.toMatch(/443 for nothing else/);
    // Backup retention is stated one way, and only one worker layout.
    expect(docs).not.toMatch(/backups 7-35 days|exactly ONE worker/);
    for (const needle of ['rds-ca.pem', 'cors.json', 'ssm:GetParameters', 'ssmmessages']) {
      expect(docs, needle).toContain(needle);
    }
    // Build-time egress hosts.
    for (const host of [
      'registry.npmjs.org',
      'binaries.prisma.sh',
      'deb.debian.org',
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      'checkpoint.prisma.io',
    ]) {
      expect(docs, host).toContain(host);
    }
  });

  it('every variable of docker-compose.prod.yml is a documented one', () => {
    const compose = read('docker-compose.prod.yml');
    // Values may be ${VAR} references of the compose file itself; the keys are what is checked.
    const keys = [...compose.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(20);
    const undocumented = keys.filter((key) => !byName.has(key));
    expect(undocumented, `not in .env.production.example: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('the repository paths this test relies on exist', () => {
    for (const path of ['apps/web/Dockerfile', 'apps/api/Dockerfile', '.dockerignore']) {
      expect(existsSync(join(root, path)), relative(root, join(root, path))).toBe(true);
    }
  });
});
