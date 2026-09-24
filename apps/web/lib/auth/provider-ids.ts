// Auth.js provider ids (kept in a dependency-free module so pure helpers and tests can use them).

/** Provider ids as Auth.js knows them. */
export const PROVIDER_IDS = {
  credentials: 'credentials',
  google: 'google',
  microsoftEntraId: 'microsoft-entra-id',
} as const;

/** Providers whose sign-in belongs to the staff login page (errors go back there). */
export const STAFF_PROVIDER_IDS: readonly string[] = [PROVIDER_IDS.microsoftEntraId];
