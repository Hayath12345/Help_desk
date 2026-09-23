import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const apiDir = fileURLToPath(new URL('..', import.meta.url));

// Vitest compiles workspace packages with each package's own tsconfig, but `pnpm dev` /
// `pnpm start` run through tsx, which applies only apps/api/tsconfig.json (and only to its
// `include`). This renders an email the way the server does at runtime.
describe('runtime (tsx) compatibility', () => {
  it('renders @loons/emails templates under tsx', async () => {
    const script = [
      "const { renderTemplateEmail } = await import('@loons/emails');",
      "const out = await renderTemplateEmail({ locale: 'ar', subject: 'S {{n}}', body: 'B {{n}}', variables: { n: 'x' }, cta: { label: 'Go', url: 'https://example.com/a' } });",
      "process.stdout.write(JSON.stringify({ subject: out.subject, rtl: out.html.includes('dir=\"rtl\"') }));",
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: apiDir,
      timeout: 60_000,
    });
    expect(JSON.parse(stdout)).toEqual({ subject: 'S x', rtl: true });
  }, 90_000);
});
