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
