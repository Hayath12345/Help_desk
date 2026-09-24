import { ConsoleShell } from '@/components/shell/app-shells';
import { initialsOf, requireUser } from '@/lib/session';

/** Agent console. Staff only (the proxy redirects others first; this re-checks server-side). */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(['AGENT', 'TEAM_LEAD', 'SUPER_ADMIN']);
  return (
    <ConsoleShell
      user={{
        name: user.name,
        email: user.email,
        initials: initialsOf(user.name),
        role: user.role,
      }}
    >
      {children}
    </ConsoleShell>
  );
}
