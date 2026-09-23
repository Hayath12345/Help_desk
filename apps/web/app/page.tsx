import { WEB_ROUTES } from '@loons/shared';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { landingPathFor } from '@/lib/auth/routing';
import { getCurrentUser } from '@/lib/session';

/** `/` → the signed-in user's home (or the approval page), otherwise the client login. */
export default async function Home(): Promise<never> {
  const user = await getCurrentUser();
  if (!user) redirect(WEB_ROUTES.clientLogin);
  redirect(landingPathFor(user) as Route);
}
