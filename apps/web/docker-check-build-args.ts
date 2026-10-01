// Build-time check of the web image's two public addresses (apps/web/Dockerfile, before `next build`).
//
// NEXT_PUBLIC_API_URL and NEXT_PUBLIC_UPLOAD_ORIGIN are baked into the client bundle and into the
// Content-Security-Policy, so a wrong value ships a page that cannot reach the API (or, worse, one
// that talks to the browser's own machine). A production image therefore needs https addresses of
// real hosts; only the local rehearsal (REHEARSAL_BUILD=true, docker-compose.prod.yml) may use
// plain http and localhost. Run with Node's built-in TypeScript support: `node docker-check-build-args.ts`.
import { isLocalHostname } from '@loons/shared';

type Env = Record<string, string | undefined>;

/** What is wrong with the two build arguments (variable names only, never a rejected value in full). */
export function publicUrlProblems(env: Env): string[] {
  const rehearsal = env.REHEARSAL_BUILD === 'true';
  const problems: string[] = [];
  for (const name of ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_UPLOAD_ORIGIN']) {
    const value = env[name]?.trim() ?? '';
    if (value === '') {
      problems.push(`${name} build argument is required`);
      continue;
    }
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      // reported below
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      problems.push(`${name} must be an http(s) URL`);
    } else if (!rehearsal && url.protocol !== 'https:') {
      problems.push(
        `${name} must be an https:// URL (set REHEARSAL_BUILD=true only for the local rehearsal image)`,
      );
    } else if (!rehearsal && isLocalHostname(url.hostname)) {
      problems.push(
        `${name} must not point at localhost (set REHEARSAL_BUILD=true only for the local rehearsal image)`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = publicUrlProblems(process.env);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[build] ${problem}`);
    process.exit(1);
  }
}
