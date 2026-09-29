// Mirrors of the Prisma enums, usable in the browser without the Prisma client.
// `packages/db` has a type-level test that fails if these drift from schema.prisma.

export const ROLES = ['CLIENT', 'AGENT', 'TEAM_LEAD', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES = ['AGENT', 'TEAM_LEAD', 'SUPER_ADMIN'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'PENDING_APPROVAL', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const TICKET_TYPES = [
  'INCIDENT',
  'SERVICE_REQUEST',
  'CHANGE_REQUEST',
  'SECURITY_INCIDENT',
  'ENQUIRY',
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const IMPACTS = ['SINGLE_USER', 'DEPARTMENT', 'ENTIRE_SITE', 'MULTIPLE_SITES'] as const;
export type Impact = (typeof IMPACTS)[number];

export const TICKET_STATUSES = ['NEW', 'OPEN', 'PENDING', 'SOLVED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_CHANNELS = ['PORTAL', 'EMAIL', 'PHONE', 'API'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];

export const MESSAGE_TYPES = ['PUBLIC', 'INTERNAL', 'SYSTEM'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DROPDOWN',
  'MULTI_SELECT',
  'DATE',
  'YES_NO',
  'ASSET_ID',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CONTRACT_TYPES = ['AMC', 'BILLABLE'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const TEAM_MEMBER_ROLES = ['MEMBER', 'LEAD'] as const;
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

// ───────────── Phase 3: SLA signals and notifications ─────────────

/** The two SLA targets of a ticket. */
export const SLA_TARGETS = ['FIRST_REPLY', 'RESOLUTION'] as const;
export type SlaTarget = (typeof SLA_TARGETS)[number];

/** A crossed SLA threshold: `atRiskPercent` of the window (AT_RISK) or 100 % (BREACHED). */
export const SLA_SIGNAL_KINDS = ['AT_RISK', 'BREACHED'] as const;
export type SlaSignalKind = (typeof SLA_SIGNAL_KINDS)[number];

/** In-app notification types (the web renders each from `type` + `data`, in the viewer's language). */
export const NOTIFICATION_TYPES = [
  'TICKET_CREATED',
  'TICKET_ASSIGNED',
  'CLIENT_REPLY',
  'AGENT_REPLY',
  'STATUS_CHANGED',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'P1_CREATED',
  'P1_ESCALATED',
  'P1_ACKNOWLEDGED',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Outbound channels logged in NotificationDelivery. */
export const NOTIFICATION_CHANNELS = ['EMAIL', 'TEAMS', 'SMS'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_DELIVERY_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];
