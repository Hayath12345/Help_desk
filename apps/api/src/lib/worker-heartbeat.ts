// Worker liveness for container health checks (Phase 6, decision G4).
//
// The worker has no HTTP port. While it is healthy it rewrites a small file every few seconds
// (WORKER_HEARTBEAT_FILE, in /tmp in the image); the container health check runs
// `node src/healthcheck-worker.ts`, which exits 0 only when the file is fresh. A worker whose
// event loop is blocked, whose BullMQ consumers stopped, or that is shutting down stops
// refreshing it and is replaced by the orchestrator. Dependency outages (Redis, the database) are
// deliberately NOT part of it: a restart does not fix them, and alarms on queue depth / errors
// are the right signal (docs/DEPLOYMENT.md).
//
// Imports only Node built-ins: the health check runs as a plain `node` process every 30 s.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How often a healthy worker refreshes the file. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** The health check accepts a heartbeat up to this old (three missed beats). */
export const HEARTBEAT_MAX_AGE_MS = 35_000;

export interface Heartbeat {
  /** Epoch ms of the last beat. */
  at: number;
  pid: number;
}

/** Writes the heartbeat atomically (a reader never sees a half-written file). */
export function writeHeartbeat(file: string, now: number = Date.now()): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ at: now, pid: process.pid } satisfies Heartbeat));
  renameSync(temp, file);
}

export type HeartbeatVerdict =
  { ok: true; ageMs: number } | { ok: false; reason: 'missing' | 'unreadable' | 'stale' };

/** Reads the heartbeat file and decides whether the worker is alive. */
export function checkHeartbeat(
  file: string,
  { now = Date.now(), maxAgeMs = HEARTBEAT_MAX_AGE_MS }: { now?: number; maxAgeMs?: number } = {},
): HeartbeatVerdict {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  let at: unknown;
  try {
    at = (JSON.parse(raw) as Partial<Heartbeat>).at;
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) return { ok: false, reason: 'unreadable' };
  const ageMs = now - at;
  // A heartbeat from the future (clock step) counts as stale rather than eternally fresh.
  return ageMs >= 0 && ageMs <= maxAgeMs ? { ok: true, ageMs } : { ok: false, reason: 'stale' };
}

export interface HeartbeatOptions {
  file: string;
  /** Beats only while this returns true (the BullMQ consumers are running and not closing). */
  isHealthy: () => boolean;
  intervalMs?: number;
  /** Called when the file cannot be written (the health check then fails by itself). */
  onError?: (err: unknown) => void;
  now?: () => number;
}

export interface HeartbeatHandle {
  /** Stops beating and removes the file (a stopped worker is not alive). */
  stop(): void;
}

/** Beats immediately and then every `intervalMs` for as long as `isHealthy()` holds. */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const { file, isHealthy, onError, now = Date.now } = options;
  const beat = (): void => {
    if (!isHealthy()) return;
    try {
      writeHeartbeat(file, now());
    } catch (err) {
      onError?.(err);
    }
  };
  beat();
  const timer = setInterval(beat, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Never keeps the process alive by itself.
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      rmSync(file, { force: true });
    },
  };
}
