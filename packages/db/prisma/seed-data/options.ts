// What the seed script does, from the environment (no database access). Uses the same env parsers
// as the web app and the API, so one `.env` value means the same thing everywhere.

import { parseBooleanEnv, parseStaffEmailDomain } from '@loons/shared';

/** NODE_ENV values that count as a non-production environment (anything else, unset included, doesn't). */
export const DEMO_NODE_ENVS = ['development', 'test'] as const;

export interface SeedOptions {
  /**
   * Demo organisations, users (with the public demo password) and tickets. Opt-in: only when
   * SEED_DEMO_DATA is true AND NODE_ENV is explicitly development or test. An unset or unknown
   * NODE_ENV counts as production (fail-safe, like the API), so a production seed run that forgot
   * NODE_ENV never creates accounts with the public demo password. `pnpm db:seed` sets development.
   */
  demo: boolean;
  /** STAFF_EMAIL_DOMAIN (blank → the default), for the SEED_ADMIN_EMAIL check. */
  staffEmailDomain: string;
}

export function seedOptions(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase() ?? '';
  const nonProduction = (DEMO_NODE_ENVS as readonly string[]).includes(nodeEnv);
  // Parsed either way, so a typo fails loudly in every environment.
  const wantsDemo = parseBooleanEnv('SEED_DEMO_DATA', env.SEED_DEMO_DATA, false);
  return {
    demo: nonProduction && wantsDemo,
    staffEmailDomain: parseStaffEmailDomain(env.STAFF_EMAIL_DOMAIN),
  };
}
