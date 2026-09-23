import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const CI = Boolean(process.env.CI);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  testDir: './e2e',
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
