import { ConsoleShell } from '@/components/shell/app-shells';
import { TicketingProviders } from '@/components/tickets/providers';
import { initialsOf, requireUser } from '@/lib/session';

/**
 * Agent console. Staff only (the proxy redirects others first; this re-checks server-side).
 * TicketingProviders: the viewer, the tab's realtime connection and the New ticket modal.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser(['AGENT', 'TEAM_LEAD', 'SUPER_ADMIN']);
  return (
    <TicketingProviders viewer={{ id: user.id, name: user.name, role: user.role }}>
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
    </TicketingProviders>
  );
}
