// Start-up configuration check (Node.js runtime only; called from instrumentation.ts).
import 'server-only';
import { assertWebEnv } from './env';

/**
 * Refuses to serve with placeholder secrets or invalid auth settings, in every environment: a
 * placeholder AUTH_SECRET would let anyone forge a session cookie (and so mint API tokens).
 * A production server (next start / standalone) exits so the deployment fails instead of coming
 * up and answering 500s; in development every request shows the error until .env is fixed.
 */
export function checkWebEnvAtStartup(): void {
  try {
    assertWebEnv();
  } catch (error) {
    console.error(`[config] ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.NODE_ENV === 'production') process.exit(1);
    throw error;
  }
}
