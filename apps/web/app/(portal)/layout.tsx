import { PortalShell } from '@/components/shell/app-shells';
import { TicketingProviders } from '@/components/tickets/providers';
import { initialsOf, requireUser } from '@/lib/session';

/**
 * Client portal. Clients only (the proxy redirects others first; this re-checks server-side).
 * `TicketingProviders` gives every portal page the viewer, the tab's realtime connection and the
 * New ticket modal ("+ New ticket" in the top bar, empty states and the Help center).
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(['CLIENT']);
  return (
    <TicketingProviders viewer={{ id: user.id, name: user.name, role: user.role }}>
      <PortalShell
        user={{
          name: user.name,
          email: user.email,
          initials: initialsOf(user.name),
          role: user.role,
        }}
      >
        {children}
      </PortalShell>
    </TicketingProviders>
  );
}
