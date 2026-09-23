// Lets a server action learn WHO just signed in, so it can redirect straight to that user's
// destination. (Redirecting to "/" and letting the page redirect again leaves the browser URL at
// "/" after a server action — Next does not reflect chained redirects in the client URL.)
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionUser } from './session-user';

const storage = new AsyncLocalStorage<{ user: SessionUser | null }>();

/** Runs `signInCall` and returns the user the jwt callback accepted during it (if any). */
export async function captureSignedInUser<T>(
  signInCall: () => Promise<T>,
): Promise<{ result: T; user: SessionUser | null }> {
  const holder: { user: SessionUser | null } = { user: null };
  const result = await storage.run(holder, signInCall);
  return { result, user: holder.user };
}

/** Called by the jwt callback on sign-in; a no-op outside captureSignedInUser(). */
export function recordSignedInUser(user: SessionUser): void {
  const holder = storage.getStore();
  if (holder) holder.user = user;
}
