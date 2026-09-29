// ─────────────────────────────────────────────────────────────────────────────────────────────
// components/tickets — shared ticket UI (docs/PHASE2_CONTRACT.md → Web → Shared ticket UI)
//
// Data comes from lib/tickets (queries/mutations), lib/realtime (rooms, typing) and lib/uploads.
// Messages live in the `tickets` namespace (messages/{en,ar}/tickets.json). Everything is
// RTL-aware, keyboard accessible and uses design tokens only.
//
// Setup (once per signed-in area — portal and console layouts, around the shell):
//   TicketingProviders({ viewer: { id, name, role }, realtime? })
//                           ViewerProvider + RealtimeProvider + NewTicketProvider in one wrapper.
//
// New ticket
//   NewTicketProvider       Hosts the modal; after creating: toast "Ticket LG-n created · routed to
//                           <team>" and navigate (client → /tickets/LG-n, staff →
//                           /console/inbox?ticket=LG-n). Needs ViewerProvider above it.
//   useNewTicket()          { open(defaults?), close(), prefetch(), available } — entry points call
//                           open() (staff may pass { requesterId } to prefill the requester).
//   NewTicketModal          The dialog itself (controlled: open, onOpenChange, isStaff, onCreated).
//   NewTicketForm           The form inside the dialog (header, fields, footer); exported for tests
//                           and custom hosts.
//   ticketHref(ticket, staff)  Where a ticket opens for clients / staff.
//
// Thread
//   TicketThread            Conversation list: skeletons, slide-in messages (direction-aware), pending /
//                           failed optimistic messages (Retry / Discard), typing indicator, `role=log`.
//                           Props: messages, isLoading, isError, onReload, onRetry, onDiscard,
//                           typingUsers, emptyText, gap ('portal' | 'console'), labelled (false
//                           when the container already is the named "Conversation" region).
//   MessageBubble           One message: avatar, author, role tag (Client / Loons Support / Internal
//                           note), time, body, attachments; SYSTEM messages as a quiet line.
//   MessageBody             Body text with preserved line breaks and safe, linkified URLs.
//   messageKind(message)    'client' | 'support' | 'internal' | 'system'.
//   linkify(text)           Splits text into text / link parts (http(s) only).
//   TypingIndicator         "Maya is typing…" live region; feed it useTyping().typingUsers.
//   useTypingText(users)    The sentence alone.
//
// SLA
//   SlaText                 List SLA cell: countdown / "Overdue 12m" / "Replied" / "Paused" / done status.
//   slaTone(state), SLA_TONE_TEXT, SLA_TONE_BAR
//                           Tone of a `slaState()` (ok | risk | overdue | done | paused | replied) and
//                           its text / bar classes (for the console SLA card).
//
// Attachments
//   AttachmentDropzone      Drag-and-drop / browse zone + upload chips (progress, remove, retry) and
//                           inline rejection messages. Props: uploads (useAttachmentUploads()),
//                           compact, disabled, id, onRejected.
//   UploadChip, UploadChipList
//                           One upload's chip (size / progress, Retry / Remove, the failure reason
//                           under it) and the list of them; `progress`: 'beside-size' (forms) or
//                           'instead-of-size' (the console composer). Used by AttachmentDropzone
//                           and the console composer.
//   useNewestUploadFailure(items, scope?), useUploadFailureText()
//                           The upload that failed last (what a status region announces) and why.
//   AttachmentChips         Read-only chips of stored attachments; click downloads (signed URL).
//   FileTypeIcon, attachmentChipClass, fileSizeParts, useFileSizeFormatter
//
// Form building blocks (reuse them in composers and the console right panel)
//   SegmentedControl        Accessible segmented radios (type / impact / status): one tab stop, arrow
//                           keys (RTL-aware); `checkedClassName(value)` tints the checked segment.
//   Combobox                Searchable single-select (site / requester pickers; local or server search).
//   FormField, fieldA11y    Label + control + hint + error with the aria wiring.
//   ContractBadge, OrgChip  "AMC" / "Billable" pill and the organisation chip.
//   PriorityCards           P1–P4 radio cards with first-reply targets.
//   CustomFieldInput        One typed category custom field (react-hook-form controlled).
// ─────────────────────────────────────────────────────────────────────────────────────────────

export { AttachmentChips, FileTypeIcon, attachmentChipClass } from './attachment-chips';
export { AttachmentDropzone, type AttachmentDropzoneProps } from './attachment-dropzone';
export {
  UploadChip,
  UploadChipList,
  useNewestUploadFailure,
  useUploadFailureText,
  type UploadChipProgress,
  type UploadChipProps,
} from './upload-chip';
export { Combobox, type ComboboxOption, type ComboboxProps } from './combobox';
export { fileSizeParts, useFileSizeFormatter } from './file-size';
export { FormField, fieldA11y, type FormFieldProps } from './form-field';
export { linkify, type TextPart } from './linkify';
export {
  MessageBody,
  MessageBubble,
  messageKind,
  type MessageBubbleProps,
  type MessageKind,
} from './message-bubble';
export { CustomFieldInput } from './new-ticket/custom-field-input';
export {
  NewTicketProvider,
  ticketHref,
  useNewTicket,
  type NewTicketApi,
} from './new-ticket/new-ticket-context';
export {
  NewTicketForm,
  type NewTicketDefaults,
  type NewTicketFormProps,
} from './new-ticket/new-ticket-form';
export { NewTicketModal, type NewTicketModalProps } from './new-ticket/new-ticket-modal';
export { PriorityCards } from './new-ticket/priority-cards';
export { ContractBadge, OrgChip } from './org-chip';
export { TicketingProviders } from './providers';
export {
  SegmentedControl,
  type FocusHandle,
  type SegmentedControlProps,
  type SegmentedOption,
} from './segmented-control';
export {
  SLA_TONE_BAR,
  SLA_TONE_TEXT,
  SlaText,
  slaTone,
  type SlaTextProps,
  type SlaTone,
} from './sla-text';
export { TicketThread, type TicketThreadProps } from './ticket-thread';
export { TypingIndicator, useTypingText } from './typing-indicator';
