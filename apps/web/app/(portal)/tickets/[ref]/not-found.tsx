import { TicketNotFound } from './_components/ticket-not-found';

/** `/tickets/<not a ticket reference>` — rendered inside the portal shell. */
export default function TicketRefNotFound() {
  return <TicketNotFound />;
}
