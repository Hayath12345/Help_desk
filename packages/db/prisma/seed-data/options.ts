// What the seed script does, from the environment (no database access). Uses the same env parsers
// as the web app and the API, so one `.env` value means the same thing everywhere.

import { parseBooleanEnv, parseStaffEmailDomain } from '@loons/shared';

export interface SeedOptions {
  /**
   * Demo organisations, users (with the public demo password) and tickets. Opt-in: only when
   * SEED_DEMO_DATA is true, and never when NODE_ENV=production.
   */
  demo: boolean;
  /** STAFF_EMAIL_DOMAIN (blank → the default), for the SEED_ADMIN_EMAIL check. */
  staffEmailDomain: string;
}

export function seedOptions(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  const production = env.NODE_ENV?.trim().toLowerCase() === 'production';
  return {
    demo: !production && parseBooleanEnv('SEED_DEMO_DATA', env.SEED_DEMO_DATA, false),
    staffEmailDomain: parseStaffEmailDomain(env.STAFF_EMAIL_DOMAIN),
  };
}
