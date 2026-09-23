import { PortalShell } from '@/components/shell/app-shells';
import { initialsOf, requireUser } from '@/lib/session';

/** Client portal. Clients only (the proxy redirects others first; this re-checks server-side). */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(['CLIENT']);
  return (
    <PortalShell user={{ name: user.name, email: user.email, initials: initialsOf(user.name), role: user.role }}>
      {children}
    </PortalShell>
  );
}
