// `pnpm test` for the API: runs `vitest run` (dropping the `--` that `pnpm test -- <files>` passes
// on). Only on a Node release known to have the bug below (with a hint to upgrade) it reruns, up to
// twice, the test files whose worker was killed by the Windows fail-fast 0xC0000409 while nothing
// else failed. The repo requires Node >= 24.16.0 (`engines`), where such a crash is a real failure.
//
// Why (review F8): on Windows, Node 24.15 and older vendor libuv 1.51, whose
// uv__is_fast_loopback_fail_supported() (src/win/tcp.c) passes an uninitialised OSVERSIONINFOW to
// RtlGetVersion on every loopback TCP connect. That can overwrite the stack cookie and kill the
// process with STATUS_STACK_BUFFER_OVERRUN (fast-fail 2) and no output. Fixed by libuv#5107,
// cherry-picked into Node 24.16.0 (nodejs/node#62561); libuv#5274 was closed as its duplicate. The
// suite makes thousands of loopback connections (Postgres, Redis, Socket.IO, MinIO), so on an
// affected Node most full runs lose a worker. It is not this code base: it also happened with no
// native addon loaded in the workers. A crashed file's tests never reported, so running that file
// again is a complete, honest result; any assertion failure, any other error, another exit code
// or a crash beyond the allowed reruns still fails the run.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 0xC0000409 as Node reports a child's exit code on Windows. */
export const FAIL_FAST_EXIT_CODE = 3_221_226_505;

const CRASH =
  /Worker exited unexpectedly with exit code (\d+) during \w+ state while running test file (\S+)/g;

/**
 * The test files to run again, or null when the run must fail as it is: something other than
 * fail-fast worker crashes went wrong (a failed test or file, another error, another exit code).
 */
export function filesToRerun(output: string): string[] | null {
  const text = stripAnsi(output);
  const crashes = [...text.matchAll(CRASH)];
  if (crashes.length === 0) return null;
  if (crashes.some((m) => Number(m[1]) !== FAIL_FAST_EXIT_CODE)) return null;
  if (/^\s*(?:Test Files|Tests)\s+.*\b\d+ failed\b/m.test(text)) return null;
  const errors = /^\s*Errors\s+(\d+) errors?\b/m.exec(text);
  if (!errors || Number(errors[1]) !== crashes.length) return null;
  return [...new Set(crashes.map((m) => m[2]!))];
}

/**
 * True for Node releases with the libuv loopback-connect bug on Windows: Node 24 before 24.16.0
 * (the only line `engines` allows that shipped it without the fix).
 */
export function hasLoopbackCrashBug(
  platform: string = process.platform,
  nodeVersion: string = process.versions.node,
): boolean {
  if (platform !== 'win32') return false;
  const [major, minor] = nodeVersion.split('.').map(Number);
  return major === 24 && (minor ?? 0) < 16;
}

/** How many times a crashed file may run again: twice where the bug is known, else never. */
export function maxReruns(affected: boolean = hasLoopbackCrashBug()): number {
  return affected ? 2 : 0;
}

export const UPGRADE_HINT =
  'This Node release has a libuv bug that crashes loopback TCP connections on Windows now and ' +
  'then (fixed in Node 24.16.0, libuv#5107). Upgrade Node to 24.16 or newer to stop these crashes.';

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Runs `vitest run …args`, echoing its output live; resolves with the exit code and output. */
function runVitest(args: string[]): Promise<{ code: number; output: string }> {
  const require = createRequire(import.meta.url);
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, 'run', ...args], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  // `pnpm test -- <files>` forwards the `--` too; vitest would then ignore the filters.
  const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));
  let run = await runVitest(args);
  const affected = hasLoopbackCrashBug();
  for (let rerun = 1; run.code !== 0; rerun += 1) {
    const files = filesToRerun(run.output);
    if (!files || rerun > maxReruns(affected)) break;
    console.warn(
      `\n[test] A test worker was killed by the Windows fail-fast 0xC0000409 (Node/libuv, see ` +
        `test/run-vitest.ts). Running ${files.length === 1 ? 'that file' : 'those files'} again ` +
        `(rerun ${rerun} of ${maxReruns(affected)}):\n  ${files.join('\n  ')}` +
        (affected ? `\n[test] ${UPGRADE_HINT}` : ''),
    );
    run = await runVitest(files.map((file) => relative(process.cwd(), file).replaceAll('\\', '/')));
  }
  process.exitCode = run.code;
}

const entry = process.argv[1];
if (entry && resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  await main();
}
