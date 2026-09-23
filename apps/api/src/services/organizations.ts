import type { PrismaClient } from '@loons/db';

/**
 * The active organisation whose `emailDomains` contains `domain` (exact, lower-case).
 * Ambiguous matches (several organisations list the domain) return null so an admin decides.
 */
export async function matchOrganizationByDomain(
  prisma: PrismaClient,
  domain: string,
): Promise<{ id: string } | null> {
  if (!domain) return null;
  const orgs = await prisma.organization.findMany({
    where: { isActive: true, emailDomains: { has: domain.toLowerCase() } },
    select: { id: true },
    take: 2,
  });
  return orgs.length === 1 ? (orgs[0] ?? null) : null;
}
