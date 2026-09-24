// Playwright global teardown: removes the accounts this run created (e2e-<timestamp>@hamad.qa…)
// through the db package's cleanup script, so repeated runs don't pile up clients in the seeded
// organisations. The web app itself never touches the database; this is test tooling.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default function globalTeardown(): void {
  // Through a shell on purpose: on Windows `pnpm` is a .cmd shim, which Node won't spawn without
  // one. The command is a constant string, so there is nothing to escape.
  execSync('pnpm --filter @loons/db db:cleanup-e2e', { cwd: repoRoot, stdio: 'inherit' });
}
