import { AdminShell } from '@/components/shell/app-shells';
import { initialsOf, requireUser } from '@/lib/session';

/**
 * Admin panel. Super admins see every section; team leads only Teams and Macros (the API
 * enforces the same rules; the proxy and this layout redirect everyone else).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(['SUPER_ADMIN', 'TEAM_LEAD']);
  return (
    <AdminShell
      user={{
        name: user.name,
        email: user.email,
        initials: initialsOf(user.name),
        role: user.role,
      }}
    >
      {children}
    </AdminShell>
  );
}
