import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_AGE_MS,
  checkHeartbeat,
  startHeartbeat,
  writeHeartbeat,
} from './worker-heartbeat.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loons-hb-'));
  file = join(dir, 'nested', 'heartbeat');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('heartbeat file', () => {
  it('a fresh beat is alive, an old one is stale, a missing or damaged file is not alive', () => {
    expect(checkHeartbeat(file)).toEqual({ ok: false, reason: 'missing' });
    writeHeartbeat(file, 1_000_000);
    expect(checkHeartbeat(file, { now: 1_000_000 + 5_000 })).toEqual({ ok: true, ageMs: 5_000 });
    expect(checkHeartbeat(file, { now: 1_000_000 + HEARTBEAT_MAX_AGE_MS })).toMatchObject({
      ok: true,
    });
    expect(checkHeartbeat(file, { now: 1_000_000 + HEARTBEAT_MAX_AGE_MS + 1 })).toEqual({
      ok: false,
      reason: 'stale',
    });
    // A beat "from the future" (the clock stepped back) is not eternally fresh.
    expect(checkHeartbeat(file, { now: 1_000_000 - 1 })).toEqual({ ok: false, reason: 'stale' });

    for (const damaged of ['', 'not json', '{}', '{"at":"yesterday"}', '{"at":null}']) {
      writeFileSync(file, damaged);
      expect(checkHeartbeat(file, { now: 1_000_000 }), damaged).toEqual({
        ok: false,
        reason: 'unreadable',
      });
    }
  });

  it('writes atomically (no temp file is left behind) and creates the directory', () => {
    writeHeartbeat(file, 42);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ at: 42, pid: process.pid });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('the allowed age covers at least three beats', () => {
    expect(HEARTBEAT_MAX_AGE_MS).toBeGreaterThanOrEqual(3 * HEARTBEAT_INTERVAL_MS);
  });
});

describe('startHeartbeat', () => {
  it('beats now and then every interval while the worker is healthy', () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const handle = startHeartbeat({
      file,
      isHealthy: () => true,
      intervalMs: 10_000,
      now: () => clock,
    });
    expect(checkHeartbeat(file, { now: 1_000 })).toMatchObject({ ok: true });
    clock = 11_000;
    vi.advanceTimersByTime(10_000);
    expect(JSON.parse(readFileSync(file, 'utf8')).at).toBe(11_000);
    handle.stop();
  });

  it('stops beating the moment the worker is not healthy (the file goes stale)', () => {
    vi.useFakeTimers();
    let healthy = true;
    let clock = 0;
    const handle = startHeartbeat({
      file,
      isHealthy: () => healthy,
      intervalMs: 10_000,
      now: () => clock,
    });
    healthy = false; // the BullMQ consumers stopped, or the worker is shutting down
    for (let i = 0; i < 6; i += 1) {
      clock += 10_000;
      vi.advanceTimersByTime(10_000);
    }
    expect(JSON.parse(readFileSync(file, 'utf8')).at).toBe(0);
    expect(checkHeartbeat(file, { now: clock })).toEqual({ ok: false, reason: 'stale' });
    handle.stop();
  });

  it('does not write at all when the worker is unhealthy from the start', () => {
    vi.useFakeTimers();
    const handle = startHeartbeat({ file, isHealthy: () => false });
    vi.advanceTimersByTime(60_000);
    expect(existsSync(file)).toBe(false);
    handle.stop();
  });

  it('stop() removes the file: a stopped worker is not alive', () => {
    const handle = startHeartbeat({ file, isHealthy: () => true });
    expect(existsSync(file)).toBe(true);
    handle.stop();
    expect(existsSync(file)).toBe(false);
    expect(checkHeartbeat(file)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports a write failure instead of throwing, and keeps trying', () => {
    vi.useFakeTimers();
    // The directory path is occupied by a file, so mkdir / write fail.
    writeFileSync(join(dir, 'nested'), 'x');
    const errors: unknown[] = [];
    const handle = startHeartbeat({
      file,
      isHealthy: () => true,
      intervalMs: 1_000,
      onError: (err) => errors.push(err),
    });
    vi.advanceTimersByTime(2_000);
    expect(errors.length).toBe(3);
    handle.stop();
  });
});

describe('healthcheck-worker.ts (what the container HEALTHCHECK runs)', () => {
  const script = fileURLToPath(new URL('../healthcheck-worker.ts', import.meta.url));

  function run(env: Record<string, string>) {
    return spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
  }

  it('exits 0 for a fresh heartbeat, 1 for a stale, missing or unconfigured one', () => {
    writeHeartbeat(file);
    expect(run({ WORKER_HEARTBEAT_FILE: file }).status).toBe(0);

    const stale = new Date(Date.now() - 120_000);
    writeHeartbeat(file, stale.getTime());
    utimesSync(file, stale, stale);
    const old = run({ WORKER_HEARTBEAT_FILE: file });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('stale');

    expect(run({ WORKER_HEARTBEAT_FILE: join(dir, 'missing') }).status).toBe(1);
    const unset = run({});
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain('WORKER_HEARTBEAT_FILE is not set');
  });
});
