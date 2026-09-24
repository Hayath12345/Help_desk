// Runs once when a Next.js server starts (`next dev` / `next start`; never during `next build`):
// validates the auth configuration and refuses placeholder secrets (lib/auth/startup.ts).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { checkWebEnvAtStartup } = await import('./lib/auth/startup');
  checkWebEnvAtStartup();
}
