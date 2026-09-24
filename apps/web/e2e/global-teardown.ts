// Playwright global teardown: removes the accounts this run created (e2e-<timestamp>@hamad.qa…)
// through the db package's cleanup script, so repeated runs don't pile up clients in the seeded
// organisations. The web app itself never touches the database; this is test tooling.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default function globalTeardown(): void {
  execFileSync('pnpm', ['--filter', '@loons/db', 'db:cleanup-e2e'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
