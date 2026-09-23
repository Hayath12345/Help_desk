import type { Role } from '@loons/shared';

/** The serialisable slice of the signed-in user that the client-side shells need. */
export interface ShellUser {
  name: string;
  email: string;
  /** Pre-computed on the server with `initialsOf(name)` from `@/lib/session`. */
  initials: string;
  role: Role;
}
