import type { PrismaClient } from '@loons/db';
import {
  STAFF_ROLES,
  canAccessAdmin,
  normalizeE164,
  type Actor,
  type StaffDirectoryEntry,
  type StaffDirectoryQuery,
} from '@loons/shared';
import { errors } from '../../lib/errors.ts';

// GET /admin/staff-directory — active staff for the admin pickers (team members, on-call user,
// escalation USER target, account manager). Phone numbers never leave: only whether one is set
// and usable for SMS.

export interface StaffDirectoryService {
  list(actor: Actor, query: StaffDirectoryQuery): Promise<StaffDirectoryEntry[]>;
}

function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createStaffDirectoryService(deps: { prisma: PrismaClient }): StaffDirectoryService {
  const { prisma } = deps;
  return {
    async list(actor, query) {
      if (!canAccessAdmin(actor)) throw errors.forbidden();
      const term = query.search?.trim();
      const users = await prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          role: query.role ? query.role : { in: [...STAFF_ROLES] },
          ...(query.teamId ? { teamMemberships: { some: { teamId: query.teamId } } } : {}),
          ...(term
            ? {
                OR: [
                  { name: { contains: likeEscape(term), mode: 'insensitive' } },
                  { email: { contains: likeEscape(term), mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: query.limit,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          jobTitle: true,
          phone: true,
          teamMemberships: {
            where: { team: { isActive: true } },
            orderBy: { teamId: 'asc' },
            select: { teamId: true, role: true },
          },
        },
      });
      return users.flatMap((u) =>
        u.role === 'CLIENT'
          ? []
          : [
              {
                id: u.id,
                name: u.name,
                email: u.email,
                role: u.role,
                jobTitle: u.jobTitle,
                hasPhone: Boolean(u.phone?.trim()),
                phoneValid: normalizeE164(u.phone) !== null,
                teams: u.teamMemberships.map((m) => ({ teamId: m.teamId, memberRole: m.role })),
              },
            ],
      );
    },
  };
}
