import type { PrismaClient } from '@loons/db';
import type { AuthUser, Locale, TeamMemberRole } from '@loons/shared';
import type { PrincipalStore } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';

export interface MeTeam {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string;
  role: TeamMemberRole;
}

export interface MeResult {
  user: AuthUser;
  org: { id: string; name: string } | null;
  teams: MeTeam[];
}

export interface MeService {
  get(userId: string): Promise<MeResult>;
  updateLocale(userId: string, locale: Locale): Promise<void>;
}

export function createMeService(deps: {
  prisma: PrismaClient;
  principals: PrincipalStore;
}): MeService {
  const { prisma, principals } = deps;

  return {
    async get(userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          orgId: true,
          locale: true,
          sessionVersion: true,
          emailVerifiedAt: true,
          org: { select: { id: true, name: true } },
          teamMemberships: {
            select: {
              role: true,
              team: {
                select: { id: true, key: true, nameEn: true, nameAr: true, sortOrder: true },
              },
            },
          },
        },
      });
      if (!user) throw errors.unauthenticated('Unknown user');
      const teams = user.teamMemberships
        .slice()
        .sort(
          (a, b) =>
            a.team.sortOrder - b.team.sortOrder || a.team.nameEn.localeCompare(b.team.nameEn),
        )
        .map((m) => ({
          id: m.team.id,
          key: m.team.key,
          nameEn: m.team.nameEn,
          nameAr: m.team.nameAr,
          role: m.role,
        }));
      const emailVerified = user.emailVerifiedAt !== null;
      // A client who hasn't proved they own the address sees nothing of the organisation it matched.
      const showOrg = user.org && (user.role !== 'CLIENT' || emailVerified);
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          orgId: user.orgId,
          locale: user.locale,
          teamIds: teams.map((t) => t.id),
          sessionVersion: user.sessionVersion,
          emailVerified,
        },
        org: showOrg && user.org ? { id: user.org.id, name: user.org.name } : null,
        teams,
      };
    },

    async updateLocale(userId, locale) {
      await prisma.user.update({ where: { id: userId }, data: { locale } });
      await principals.invalidate(userId);
    },
  };
}
