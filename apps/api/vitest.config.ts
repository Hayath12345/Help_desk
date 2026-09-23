import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Integration tests use the real Postgres / Redis / Mailpit from docker-compose and the
// repo-root .env (`pnpm test` loads it through dotenv-cli; this covers `vitest` run directly).
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file builds its own app; a few in parallel keeps argon2 hashing from starving the DB.
    maxWorkers: 4,
  },
});
