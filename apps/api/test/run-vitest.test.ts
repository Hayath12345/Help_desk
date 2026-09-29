import { describe, expect, it } from 'vitest';
import { FAIL_FAST_EXIT_CODE, filesToRerun, hasLoopbackCrashBug, maxReruns } from './run-vitest.ts';

// The API test runner reruns a file only when its worker died of the Windows fail-fast (review
// F8, the libuv loopback-connect bug fixed in Node 24.16.0) and nothing else went wrong.

const FILE = 'C:/repo/apps/api/test/realtime-tickets.test.ts';
const crash = (file = FILE, code = FAIL_FAST_EXIT_CODE) =>
  `Caused by: Error: Worker exited unexpectedly with exit code ${code} during started state while running test file ${file}`;
const summary = ({ files = '28 passed (29)', tests = '405 passed (420)', errors = 1 } = {}) =>
  [
    ` Test Files  ${files}`,
    `      Tests  ${tests}`,
    errors ? `     Errors  ${errors} error${errors === 1 ? '' : 's'}` : '',
    '   Duration  36.01s',
  ].join('\n');

describe('filesToRerun', () => {
  it('reruns the files whose worker died of 0xC0000409 when nothing else failed', () => {
    expect(filesToRerun(`${crash()}\n\n${summary()}`)).toEqual([FILE]);
    const other = 'C:/repo/apps/api/test/health.test.ts';
    expect(filesToRerun(`${crash()}\n${crash(other)}\n${summary({ errors: 2 })}`)).toEqual([
      FILE,
      other,
    ]);
    // Colours (a TTY) don't matter.
    expect(filesToRerun(`\u001b[31m${crash()}\u001b[39m\n${summary()}`)).toEqual([FILE]);
  });

  it('fails the run as it is otherwise', () => {
    // A failed test next to the crash.
    expect(
      filesToRerun(
        `${crash()}\n${summary({ files: '1 failed | 27 passed (29)', tests: '1 failed | 404 passed (420)' })}`,
      ),
    ).toBeNull();
    // Another unhandled error next to the crash.
    expect(filesToRerun(`${crash()}\nTypeError: boom\n${summary({ errors: 2 })}`)).toBeNull();
    // Another exit code (an assertion abort, an out-of-memory kill…).
    expect(filesToRerun(`${crash(FILE, 134)}\n${summary()}`)).toBeNull();
    // Plain failures, no crash.
    expect(filesToRerun(summary({ files: '1 failed | 28 passed (29)', errors: 0 }))).toBeNull();
    expect(filesToRerun('')).toBeNull();
  });
});

describe('hasLoopbackCrashBug / maxReruns', () => {
  it('flags Node 24 before 24.16.0 on Windows only', () => {
    expect(hasLoopbackCrashBug('win32', '24.15.0')).toBe(true);
    expect(hasLoopbackCrashBug('win32', '24.0.0')).toBe(true);
    // libuv#5107 was cherry-picked into 24.16.0.
    expect(hasLoopbackCrashBug('win32', '24.16.0')).toBe(false);
    expect(hasLoopbackCrashBug('win32', '24.21.0')).toBe(false);
    expect(hasLoopbackCrashBug('win32', '26.1.0')).toBe(false);
    // The bug is in libuv's Windows TCP code.
    expect(hasLoopbackCrashBug('linux', '24.15.0')).toBe(false);
    expect(hasLoopbackCrashBug('darwin', '24.15.0')).toBe(false);
  });

  it('allows a second rerun only where the bug is known', () => {
    expect(maxReruns(true)).toBe(2);
    expect(maxReruns(false)).toBe(1);
  });
});
