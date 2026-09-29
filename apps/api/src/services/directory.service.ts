import type { PrismaClient } from '@loons/db';
import {
  STAFF_ROLES,
  isClient,
  isStaff,
  isSuperAdmin,
  type Actor,
  type FormContext,
  type MacroDto,
  type TeamWithMembers,
} from '@loons/shared';
import { errors } from '../lib/errors.ts';
import { requireStaff } from './ticket-access.ts';

// Look-ups for the new-ticket form and the console: who a ticket is for (requester, organisation,
// sites), the requester picker, macros and teams with their members.

export interface RequesterOption {
  id: string;
  name: string;
  email: string;
  org: { id: string; name: string; nameAr: string | null; contractType: 'AMC' | 'BILLABLE' };
}

export interface DirectoryService {
  formContext(actor: Actor, requesterId?: string): Promise<FormContext>;
  searchRequesters(
    actor: Actor,
    query: { search: string; limit: number },
  ): Promise<RequesterOption[]>;
  macros(actor: Actor): Promise<MacroDto[]>;
  teams(actor: Actor): Promise<TeamWithMembers[]>;
}

/** Requesters: active clients with a verified address in an active organisation. */
export const REQUESTER_WHERE = {
  role: 'CLIENT',
  status: 'ACTIVE',
  emailVerifiedAt: { not: null },
  orgId: { not: null },
  org: { isActive: true },
} as const;

function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createDirectoryService(deps: { prisma: PrismaClient }): DirectoryService {
  const { prisma } = deps;

  return {
    async formContext(actor, requesterId) {
      let userId: string;
      if (isStaff(actor)) {
        if (!requesterId) {
          throw errors.validation([
            {
              location: 'querystring',
              path: ['requesterId'],
              message: 'validation.required',
              code: 'required',
            },
          ]);
        }
        userId = requesterId;
      } else {
        if (!isClient(actor)) throw errors.forbidden();
        if (requesterId && requesterId !== actor.id) throw errors.forbidden();
        userId = actor.id;
      }
      const user = await prisma.user.findFirst({
        where: { id: userId, ...REQUESTER_WHERE },
        select: {
          id: true,
          name: true,
          email: true,
          org: {
            select: {
              id: true,
              name: true,
              nameAr: true,
              contractType: true,
              sites: {
                where: { isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                select: { id: true, name: true, nameAr: true },
              },
            },
          },
        },
      });
      if (!user?.org) throw errors.notFound('Requester not found');
      const { sites, ...org } = user.org;
      return { requester: { id: user.id, name: user.name, email: user.email }, org, sites };
    },

    async searchRequesters(actor, { search, limit }) {
      requireStaff(actor);
      const term = search.trim();
      const users = await prisma.user.findMany({
        where: {
          ...REQUESTER_WHERE,
          ...(term
            ? {
                OR: [
                  { name: { contains: likeEscape(term), mode: 'insensitive' } },
                  { email: { contains: likeEscape(term), mode: 'insensitive' } },
                  { org: { name: { contains: likeEscape(term), mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          org: { select: { id: true, name: true, nameAr: true, contractType: true } },
        },
      });
      return users.flatMap((u) =>
        u.org ? [{ id: u.id, name: u.name, email: u.email, org: u.org }] : [],
      );
    },

    async macros(actor) {
      requireStaff(actor);
      const rows = await prisma.macro.findMany({
        where: {
          isActive: true,
          ...(isSuperAdmin(actor)
            ? {}
            : { OR: [{ teamId: null }, { teamId: { in: [...actor.teamIds] } }] }),
        },
        orderBy: [{ sortOrder: 'asc' }, { titleEn: 'asc' }],
        select: {
          id: true,
          key: true,
          teamId: true,
          titleEn: true,
          titleAr: true,
          bodyEn: true,
          bodyAr: true,
          setStatus: true,
        },
      });
      return rows;
    },

    async teams(actor) {
      requireStaff(actor);
      const teams = await prisma.team.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        select: {
          id: true,
          key: true,
          nameEn: true,
          nameAr: true,
          members: {
            where: { user: { status: 'ACTIVE', role: { in: [...STAFF_ROLES] } } },
            select: { user: { select: { id: true, name: true, role: true } } },
          },
        },
      });
      return teams.map(({ members, ...team }) => ({
        ...team,
        members: members
          .map((m) => m.user)
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      }));
    },
  };
}
