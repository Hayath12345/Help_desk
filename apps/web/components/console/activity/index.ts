// Staff activity timeline of the console ticket panel (docs/PHASE5_CONTRACT.md F14).
//   ActivitySection({ ticketId })   Collapsible "Activity" section (staff only; loads when opened).
//   useTicketEvents(ticketId)       GET /tickets/:id/events, infinite; refetched on ticket:updated.
//   useActivityText()               { describe(event), who(event) } in the UI language.
//   activityKeys / fetchTicketEvents / ACTIVITY_PAGE_SIZE

export { ActivitySection } from './activity-section';
export { ACTIVITY_PAGE_SIZE, activityKeys, fetchTicketEvents } from './api';
export { useActivityText, type ActivityText } from './event-text';
export { ACTIVITY_REFRESH_DEBOUNCE_MS, useTicketEvents } from './use-ticket-events';
