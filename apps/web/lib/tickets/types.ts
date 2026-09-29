// Client-side types layered on the shared contract DTOs.

import type {
  AttachmentDto,
  MessageDto,
  Role,
  TicketDetailDto,
  TicketList,
  TicketSummaryDto,
} from '@loons/shared';
import type { InfiniteData } from '@tanstack/react-query';

/** What `useSendMessage().send()` takes. */
export interface SendMessageInput {
  type: 'PUBLIC' | 'INTERNAL';
  body: string;
  /** Uploaded attachment ids (see `useAttachmentUploads().attachmentIds`). */
  attachmentIds?: string[];
  /** The same attachments as DTOs, shown on the optimistic bubble until the server answers. */
  attachments?: AttachmentDto[];
  /** Staff "Send & solve". */
  andSolve?: boolean;
  /** Reused by retries so the server deduplicates (idempotent on ticketId + clientTempId). */
  clientTempId?: string;
}

export type LocalMessageStatus = 'pending' | 'failed';

/**
 * A message in the thread cache. Server messages are plain `MessageDto`s; optimistic ones carry
 * `local` (pending until the server answers, failed → Retry) and use their clientTempId as `id`.
 */
export interface ThreadMessage extends MessageDto {
  local?: { status: LocalMessageStatus; input: SendMessageInput };
}

/** Cached pages of GET /tickets. */
export type TicketPages = InfiniteData<TicketList, string | null>;

/** `useTickets().data`: the pages plus every loaded ticket, flattened in order. */
export type TicketPagesWithItems = TicketPages & { items: TicketSummaryDto[] };

/** Either DTO: detail extends summary. */
export type AnyTicketDto = TicketSummaryDto | TicketDetailDto;

/** The signed-in user as the ticket UI needs it (from `ViewerProvider`). */
export interface Viewer {
  id: string;
  name: string;
  role: Role;
}
