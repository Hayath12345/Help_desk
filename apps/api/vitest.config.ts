import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests use the real Postgres / Redis / Mailpit from docker-compose and the
// repo-root .env (`pnpm test` loads it through dotenv-cli; this covers `vitest` run directly).
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    // Stability on Windows (review F8: a test worker occasionally died with 0xC0000409, a
    // native abort, leaving Redis keys behind):
    // - one child process per worker (never worker_threads, where native addons are fragile);
    //   a crash then fails one file loudly instead of hanging the run;
    pool: 'forks',
    // - a few files in parallel keeps argon2 hashing (native threads) from starving the DB;
    maxWorkers: 4,
    // - the run's leftover Redis keys are removed even when a worker dies (global-setup.ts);
    globalSetup: ['./test/global-setup.ts'],
    env: {
      // - msgpackr (via BullMQ) would load its native msgpackr-extract addon into every worker;
      //   the API only packs job data, which msgpackr does in JavaScript either way.
      MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
    },
  },
});
