import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { ENGLISH_STORAGE_STATE } from './e2e/fixtures';

const CI = Boolean(process.env.CI);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  // Deletes the accounts the run created (packages/db/scripts/cleanup-e2e.ts).
  globalTeardown: './e2e/global-teardown.ts',
  // Sign-in is rate limited per IP + email by the API: keep the run sequential and predictable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:3000',
    locale: 'en-US',
    storageState: ENGLISH_STORAGE_STATE,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter @loons/api dev',
      url: 'http://localhost:4000/health/live',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      // Sends the emails (BullMQ `email` queue) the verification test reads from Mailpit. It has
      // no port to probe, so one is always started; an extra worker next to a running
      // `pnpm dev` is harmless (both consume the same queues; this one registers no schedulers).
      name: 'worker',
      command: 'pnpm --filter @loons/api dev:worker',
      // Consume only: the running stack's worker (or the next `pnpm dev`) owns the schedulers.
      env: { WORKER_SCHEDULERS: 'false' },
      wait: { stdout: /worker ready/ },
      cwd: repoRoot,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      name: 'web',
      command: 'pnpm --filter @loons/web dev',
      url: 'http://localhost:3000/login',
      cwd: repoRoot,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'pipe',
    },
  ],
});
