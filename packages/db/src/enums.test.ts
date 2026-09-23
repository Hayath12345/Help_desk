// Fails to compile / run if the browser-safe enum mirrors in @loons/shared drift from schema.prisma.
import * as shared from '@loons/shared';
import { describe, expect, it } from 'vitest';
import * as db from './generated/prisma/enums.ts';

const pairs: Array<[string, readonly string[], Record<string, string>]> = [
  ['Role', shared.ROLES, db.Role],
  ['UserStatus', shared.USER_STATUSES, db.UserStatus],
  ['Locale', shared.LOCALES, db.Locale],
  ['TicketType', shared.TICKET_TYPES, db.TicketType],
  ['Priority', shared.PRIORITIES, db.Priority],
  ['Impact', shared.IMPACTS, db.Impact],
  ['TicketStatus', shared.TICKET_STATUSES, db.TicketStatus],
  ['TicketChannel', shared.TICKET_CHANNELS, db.TicketChannel],
  ['MessageType', shared.MESSAGE_TYPES, db.MessageType],
  ['CustomFieldType', shared.CUSTOM_FIELD_TYPES, db.CustomFieldType],
  ['ContractType', shared.CONTRACT_TYPES, db.ContractType],
  ['TeamMemberRole', shared.TEAM_MEMBER_ROLES, db.TeamMemberRole],
];

describe('shared enum mirrors match the Prisma schema', () => {
  it.each(pairs)('%s', (_name, mirror, prismaEnum) => {
    expect([...mirror].sort()).toEqual(Object.values(prismaEnum).sort());
  });
});
