'use client';

import { RealtimeProvider } from '@/lib/realtime/provider';
import type { Viewer } from '@/lib/tickets/types';
import { ViewerProvider } from '@/lib/tickets/viewer';
import { NewTicketProvider } from './new-ticket/new-ticket-context';

/**
 * Everything the ticket UI needs for a signed-in area, in one wrapper: the viewer, the realtime
 * connection and the New ticket modal. Mount it in the portal and console layouts around the
 * shell (inside AppProviders), with the user from `requireUser()`:
 *
 *   <TicketingProviders viewer={{ id: user.id, name: user.name, role: user.role }}>
 *     <PortalShell user={…}>{children}</PortalShell>
 *   </TicketingProviders>
 */
export function TicketingProviders({
  viewer,
  realtime = true,
  children,
}: {
  viewer: Viewer;
  /** Only ACTIVE, verified users may connect (requireUser() already guarantees it). */
  realtime?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ViewerProvider viewer={viewer}>
      <RealtimeProvider enabled={realtime}>
        <NewTicketProvider>{children}</NewTicketProvider>
      </RealtimeProvider>
    </ViewerProvider>
  );
}
