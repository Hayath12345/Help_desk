import type { Prisma } from '@loons/db';
import {
  formatTicketNumber,
  ticketSummaryDtoSchema,
  type AttachmentDto,
  type MessageDto,
  type TicketSummaryDto,
} from '@loons/shared';

// Database rows → ticket API DTOs (`@loons/shared` schemas/tickets.ts). Client-facing payloads
// never contain internal notes: the preview is the latest PUBLIC message only.

export const PREVIEW_MAX_CHARS = 140;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Latest public message body, whitespace collapsed, at most 140 characters. */
export function messagePreview(body: string | null | undefined): string {
  if (!body) return '';
  const collapsed = body.replace(/\s+/g, ' ').trim();
  const chars = [...collapsed];
  if (chars.length <= PREVIEW_MAX_CHARS) return collapsed;
  return `${chars
    .slice(0, PREVIEW_MAX_CHARS - 1)
    .join('')
    .trimEnd()}…`;
}

/** Attachments shown in DTOs: uploaded (awaiting scan) or clean — never pending/rejected ones. */
export const VISIBLE_ATTACHMENT_STATUSES = ['UPLOADED', 'CLEAN'] as const;

export const attachmentSelect = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} as const satisfies Prisma.AttachmentSelect;

export type AttachmentRow = Prisma.AttachmentGetPayload<{ select: typeof attachmentSelect }>;

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export const messageSelect = {
  id: true,
  ticketId: true,
  type: true,
  body: true,
  clientTempId: true,
  authorId: true,
  createdAt: true,
  author: { select: { id: true, name: true, role: true } },
  attachments: {
    where: { status: { in: [...VISIBLE_ATTACHMENT_STATUSES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: attachmentSelect,
  },
} as const satisfies Prisma.MessageSelect;

export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    type: row.type,
    body: row.body,
    author: row.type === 'SYSTEM' ? null : row.author,
    clientTempId: row.clientTempId,
    attachments: row.attachments.map(toAttachmentDto),
    createdAt: row.createdAt.toISOString(),
  };
}

export const ticketSummarySelect = {
  id: true,
  number: true,
  subject: true,
  type: true,
  status: true,
  priority: true,
  impact: true,
  channel: true,
  orgId: true,
  teamId: true,
  assigneeId: true,
  requesterId: true,
  categoryId: true,
  subtypeId: true,
  siteId: true,
  firstReplyDueAt: true,
  resolveDueAt: true,
  firstReplyAtRiskAt: true,
  resolveAtRiskAt: true,
  firstRepliedAt: true,
  solvedAt: true,
  closedAt: true,
  slaBreached: true,
  slaPausedAt: true,
  p1Since: true,
  p1EscalationStep: true,
  p1AckedAt: true,
  lastMessageAt: true,
  createdAt: true,
  updatedAt: true,
  category: {
    select: { id: true, key: true, labelEn: true, labelAr: true, icon: true, isActive: true },
  },
  subtype: { select: { id: true, key: true, labelEn: true, labelAr: true, isActive: true } },
  team: { select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true } },
  org: { select: { id: true, name: true, nameAr: true } },
  site: { select: { id: true, name: true, nameAr: true, isActive: true } },
  requester: { select: { id: true, name: true, email: true } },
  assignee: { select: { id: true, name: true } },
  p1AckedBy: { select: { id: true, name: true } },
  tags: { select: { tag: { select: { key: true } } } },
  // The preview: latest PUBLIC message only (never an internal note).
  messages: {
    where: { type: 'PUBLIC' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { body: true },
  },
} as const satisfies Prisma.TicketSelect;

export type TicketSummaryRow = Prisma.TicketGetPayload<{ select: typeof ticketSummarySelect }>;

export function toSummaryDto(row: TicketSummaryRow): TicketSummaryDto {
  return {
    id: row.id,
    number: row.number,
    ref: formatTicketNumber(row.number),
    subject: row.subject,
    type: row.type,
    status: row.status,
    priority: row.priority,
    impact: row.impact,
    channel: row.channel,
    category: row.category,
    subtype: row.subtype,
    team: row.team,
    // Explicit: the detail select adds contract fields to `org` that summaries don't carry.
    org: { id: row.org.id, name: row.org.name, nameAr: row.org.nameAr },
    site: row.site,
    requester: row.requester,
    assignee: row.assignee,
    tags: row.tags.map((t) => t.tag.key).sort(),
    preview: messagePreview(row.messages[0]?.body),
    firstReplyDueAt: iso(row.firstReplyDueAt),
    resolveDueAt: iso(row.resolveDueAt),
    firstReplyAtRiskAt: iso(row.firstReplyAtRiskAt),
    resolveAtRiskAt: iso(row.resolveAtRiskAt),
    firstRepliedAt: iso(row.firstRepliedAt),
    solvedAt: iso(row.solvedAt),
    closedAt: iso(row.closedAt),
    slaBreached: row.slaBreached,
    slaPausedAt: iso(row.slaPausedAt),
    p1Since: iso(row.p1Since),
    p1EscalationStep: row.p1EscalationStep,
    p1AckedAt: iso(row.p1AckedAt),
    // Who acknowledged, only while the acknowledgement stands.
    p1AckedBy: row.p1AckedAt ? row.p1AckedBy : null,
    lastMessageAt: iso(row.lastMessageAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SUMMARY_KEYS = Object.keys(ticketSummaryDtoSchema.shape) as Array<keyof TicketSummaryDto>;

/**
 * The summary part of a detail DTO. Realtime payloads go to every viewer of the ticket, so they
 * must never carry the detail-only (caller-specific) fields.
 */
export function summaryOf(detail: TicketSummaryDto): TicketSummaryDto {
  return Object.fromEntries(SUMMARY_KEYS.map((k) => [k, detail[k]])) as TicketSummaryDto;
}

export const ticketDetailSelect = {
  ...ticketSummarySelect,
  description: true,
  assetId: true,
  customFields: true,
  org: {
    select: {
      id: true,
      name: true,
      nameAr: true,
      contractType: true,
      amcExpiry: true,
      accountManager: { select: { id: true, name: true } },
    },
  },
} as const satisfies Prisma.TicketSelect;

export type TicketDetailRow = Prisma.TicketGetPayload<{ select: typeof ticketDetailSelect }>;
