'use client';

import type { TeamWithMembers, TicketDetailDto } from '@loons/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { isApiRequestError } from '@/lib/api/errors';
import { fetchTicket, fetchTicketFormConfig } from '@/lib/tickets/api';
import { ticketKeys } from '@/lib/tickets/keys';
import { teamName } from '@/lib/tickets/labels';
import type { Viewer } from '@/lib/tickets/types';
import { isStaffViewer, useViewer } from '@/lib/tickets/viewer';
import type { NewTicketDefaults } from './new-ticket-form';
import { NewTicketModal } from './new-ticket-modal';

export interface NewTicketApi {
  /** Opens the New ticket modal with a fresh form (staff may prefill the requester). */
  open: (defaults?: NewTicketDefaults) => void;
  close: () => void;
  /** Warms the form configuration (call on hover / focus of an entry point). */
  prefetch: () => void;
  /** False outside a `NewTicketProvider` (entry points render disabled then). */
  available: boolean;
}

const NewTicketContext = createContext<NewTicketApi | null>(null);

const FALLBACK: NewTicketApi = {
  open: () => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[tickets] useNewTicket(): no <NewTicketProvider> above this component');
    }
  },
  close: () => undefined,
  prefetch: () => undefined,
  available: false,
};

/** Open / prefetch the New ticket modal from any entry point ("+ New ticket", the console menu). */
export function useNewTicket(): NewTicketApi {
  return useContext(NewTicketContext) ?? FALLBACK;
}

const TICKET_REF = /^LG-\d+$/;

/** Where a newly created ticket opens: the client's thread page, or the console conversation. */
export function ticketHref(
  ticket: Pick<TicketDetailDto, 'ref' | 'number'>,
  staff: boolean,
): string {
  const ref = encodeURIComponent(TICKET_REF.test(ticket.ref) ? ticket.ref : `LG-${ticket.number}`);
  return staff ? `/console/inbox?ticket=${ref}` : `/tickets/${ref}`;
}

/**
 * Whether a staff member can open a ticket they just raised. The API assigns it to them when they
 * are on the team it was routed to; otherwise it belongs to a team they can't see (spec §5: team
 * and assigned tickets only; super admins see everything), and opening it would only show "Ticket
 * not found". Decided from the answer and the cached teams when possible, else by asking the API.
 */
export async function staffCanOpenTicket(
  queryClient: QueryClient,
  ticket: TicketDetailDto,
  viewer: Viewer,
): Promise<boolean> {
  if (viewer.role === 'SUPER_ADMIN' || ticket.assignee?.id === viewer.id) return true;
  const teams = queryClient.getQueryData<TeamWithMembers[]>(ticketKeys.teams());
  const team = teams?.find((t) => t.id === ticket.team.id);
  if (team?.members.some((member) => member.id === viewer.id)) return true;
  try {
    await queryClient.fetchQuery({
      queryKey: ticketKeys.detail(ticket.ref),
      queryFn: ({ signal }) => fetchTicket(ticket.ref, signal),
      staleTime: 0,
      retry: false,
    });
    return true;
  } catch (error) {
    if (isApiRequestError(error) && (error.status === 404 || error.status === 403)) {
      // Nothing of it should stay cached for someone who can't see it.
      queryClient.removeQueries({ queryKey: ticketKeys.detail(ticket.ref), exact: true });
      return false;
    }
    return true; // can't tell (offline…): open it; the page explains a failure
  }
}

/**
 * Hosts the New ticket modal for a signed-in area and exposes `useNewTicket()`. Needs a
 * `ViewerProvider` above it (the role decides the requester picker and where a new ticket
 * opens). On success: toast "Ticket LG-n created · routed to <team>", then navigate — clients to
 * /tickets/LG-n, staff to /console/inbox?ticket=LG-n. Staff who raised a ticket for a team they
 * are not on stay where they are ("… created and routed to <team>"), and a form closed before
 * the API answered never navigates.
 */
export function NewTicketProvider({
  children,
  onCreated,
}: {
  children: React.ReactNode;
  /** Extra hook after a ticket is created (before navigation). */
  onCreated?: (ticket: TicketDetailDto) => void;
}) {
  const viewer = useViewer();
  const staff = isStaffViewer(viewer);
  const queryClient = useQueryClient();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('tickets.newTicket');
  const [state, setState] = useState<{
    open: boolean;
    session: number;
    defaults?: NewTicketDefaults;
  }>({ open: false, session: 0 });
  const returnFocus = useRef<HTMLElement | null>(null);
  // The modal as it is now, for create requests answering later (see handleCreated).
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  }, [state]);

  const open = useCallback((defaults?: NewTicketDefaults) => {
    const active = document.activeElement;
    returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setState((s) => ({ open: true, session: s.session + 1, defaults }));
  }, []);

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: ticketKeys.formConfig(),
      queryFn: ({ signal }) => fetchTicketFormConfig(signal),
      staleTime: 5 * 60_000,
    });
  }, [queryClient]);

  /** `session`: the modal session whose form sent the create request. */
  const handleCreated = useCallback(
    async (ticket: TicketDetailDto, session: number) => {
      const team = teamName(ticket.team, locale);
      // Closed (or reopened with a new form) before the API answered: the user has moved on.
      // The ticket exists, so say so — but don't navigate, nor close a form opened since.
      const dismissed = !current.current.open || current.current.session !== session;
      if (!dismissed) close();
      const visible = !staff || !viewer || (await staffCanOpenTicket(queryClient, ticket, viewer));
      onCreated?.(ticket);
      if (!visible) {
        toast.success(t('createdElsewhere', { ref: ticket.ref, team }), {
          description: t('createdElsewhereHint'),
        });
        return;
      }
      toast.success(t('created', { ref: ticket.ref, team }));
      if (!dismissed) router.push(ticketHref(ticket, staff) as Route);
    },
    [close, t, locale, onCreated, router, staff, viewer, queryClient],
  );

  const api = useMemo<NewTicketApi>(
    () => ({ open, close, prefetch, available: viewer !== null }),
    [open, close, prefetch, viewer],
  );

  return (
    <NewTicketContext.Provider value={api}>
      {children}
      {viewer && state.session > 0 ? (
        <NewTicketModal
          key={state.session}
          open={state.open}
          onOpenChange={(next) => (next ? undefined : close())}
          isStaff={staff}
          defaults={state.defaults}
          onCreated={(ticket) => void handleCreated(ticket, state.session)}
          returnFocusTo={() => returnFocus.current}
        />
      ) : null}
    </NewTicketContext.Provider>
  );
}
