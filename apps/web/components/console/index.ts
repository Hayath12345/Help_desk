// ─────────────────────────────────────────────────────────────────────────────────────────────
// components/console — agent console inbox (docs/PHASE2_CONTRACT.md → Agent console)
//
// Route: app/(console)/console/inbox/page.tsx renders <Inbox /> (Suspense fallback / loading:
// <InboxSkeleton />). The console layout mounts TicketingProviders (viewer, realtime, New ticket).
// Data: lib/tickets (queries + optimistic mutations), lib/realtime (rooms, typing), lib/uploads.
// Strings: messages/{en,ar}/console.json (+ tickets / common / validation / errors).
//
// URL state (inbox-url.ts) — `/console/inbox?view=&team=&ticket=&q=`
//   useInboxState()             Parsed state of the current URL (re-renders on History API changes).
//   updateInboxUrl(patch, mode) push / replace the query string (no reload, no server round trip).
//   parseInboxParams, inboxHref, inboxQuery, listFiltersFor, isSelectedTicket, currentInboxState,
//   INBOX_PATH, DEFAULT_VIEW, SEARCH_MAX, isStaffView, isTicketSort
//
// Screens
//   Inbox                 Views + Teams (live counts) · ticket list (SLA / recent, infinite) ·
//                         conversation + right panel. Responsive like the design: 3 columns ≥ 1180 px,
//                         views select below, single pane below 860 px (Back to list).
//   InboxSkeleton         First paint (server-compatible).
//   ViewsSidebar, ViewSelect, isPlainClick
//   TicketList, TicketRow The list column and one row (priority dot, requester · client, SLA text,
//                         subject, LG-n, status pill, assignee initials); rows animate in / out /
//                         reorder, prefetch the ticket on hover.
//   ConversationPane      Selected ticket: header, thread (yellow internal notes, typing incl. the
//                         staff room), composer, right panel; not-found / loading states.
//   ConversationHeader    `LG-n · Category › Sub-type · via channel · Site`, subject + priority.
//   Composer              Public reply / Internal note (yellow), per-mode drafts, attachments,
//                         macros ({{requesterFirstName}} / {{siteName}}, setStatus), Send & solve.
//   TicketPanel           SLA card, status segmented control, property editors (all optimistic),
//                         Assign to me, requester card.
//   SlaCard, slaCardModel The SLA countdown card and its pure model.
//   RequesterCard         Client, contract, AMC expiry, sites, account manager, other tickets.
//   PropertySelect, AssetIdEditor, TagsEditor, PropertyLabel
//
// Pure helpers
//   macros.ts             macroTitle, macroBody, macroContext, fillMacro, appendToDraft,
//                         macroStatusPlan (how a macro's status is applied when sending).
//   tags.ts               normalizeTag, tagProblem (PATCH tag rules).
//
// Tests: test-world.ts is an in-memory ticket API (contract-shaped DTOs, list filters, SLA sort,
// status rules) used by inbox.test.tsx through the real fetchers. Not used by application code.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { Composer, type ComposerMode, type ComposerProps } from './composer';
export { ConversationPane, ConversationSkeleton, type ConversationPaneProps } from './conversation';
export { ConversationHeader, type ConversationHeaderProps } from './conversation-header';
export { Inbox, INBOX_SORT_KEY } from './inbox';
export { InboxSkeleton } from './inbox-skeleton';
export {
  DEFAULT_VIEW,
  INBOX_PATH,
  SEARCH_MAX,
  currentInboxState,
  inboxHref,
  inboxQuery,
  isSelectedTicket,
  isStaffView,
  isTicketSort,
  listFiltersFor,
  parseInboxParams,
  updateInboxUrl,
  useInboxState,
  type InboxState,
} from './inbox-url';
export {
  appendToDraft,
  fillMacro,
  macroBody,
  macroContext,
  macroStatusPlan,
  macroTitle,
  type MacroContext,
} from './macros';
export {
  AssetIdEditor,
  PropertyLabel,
  PropertySelect,
  TagsEditor,
  type PropertyOption,
  type PropertySelectProps,
} from './property-editors';
export { RequesterCard } from './requester-card';
export { SlaCard, slaCardModel, type SlaCardModel } from './sla-card';
export { normalizeTag, tagProblem, type TagProblem } from './tags';
export { TicketList, type TicketListProps } from './ticket-list';
export { TicketPanel, UNASSIGNED } from './ticket-panel';
export { TicketRow, type TicketRowProps } from './ticket-row';
export {
  ViewSelect,
  ViewsSidebar,
  isPlainClick,
  type ViewSelectProps,
  type ViewsSidebarProps,
} from './views-sidebar';
