import type { Prisma, PrismaClient } from '@loons/db';
import { ACTIVE_STATUSES, STAFF_ROLES, type Priority } from '@loons/shared';

// Skills-based auto-assignment (docs/AUTO_ASSIGN.md). When a ticket is created and nobody was
// assigned by hand, the person on the category's team who has one of the skills the category asks
// for, accepts automatic tickets and has the fewest open tickets gets it. Anything that doesn't
// find such a person leaves the ticket unassigned in the team's queue, exactly as before.
//
// Rules, in order:
//  1. Priorities in AUTO_ASSIGN_SKIPS are never auto-assigned: a P1 goes through the on-call
//     escalation chain and whoever acknowledges it takes it.
//  2. The category needs at least one ACTIVE skill (CategorySkill → Skill.isActive). No skills = the
//     category opts out of auto-assignment.
//  3. Candidates are members of the category's team with an ACTIVE staff account, who accept
//     automatic tickets (`acceptsAutoAssign`) and have at least one of those skills.
//  4. The candidate with the fewest open tickets (NEW / OPEN / PENDING, across all teams) wins; ties
//     go to whoever was handed a ticket automatically longest ago (never = first), then the lowest
//     id so the result is deterministic.

/** Priorities that are never assigned automatically. */
export const AUTO_ASSIGN_SKIPS: readonly Priority[] = ['P1'];

export interface AutoAssignCandidate {
  userId: string;
  /** Tickets assigned to them that are still open. */
  openTickets: number;
  /** When a ticket was last assigned to them by the system; null = never. */
  lastAutoAssignedAt: Date | null;
}

/** The winner among `candidates` (rule 4), or null when there are none. */
export function chooseAssignee(
  candidates: readonly AutoAssignCandidate[],
): AutoAssignCandidate | null {
  let best: AutoAssignCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || beats(candidate, best)) best = candidate;
  }
  return best;
}

function beats(a: AutoAssignCandidate, b: AutoAssignCandidate): boolean {
  if (a.openTickets !== b.openTickets) return a.openTickets < b.openTickets;
  const aTime = a.lastAutoAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.lastAutoAssignedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return aTime < bTime;
  return a.userId < b.userId;
}

export interface AutoAssignInput {
  categoryId: string;
  teamId: string;
  priority: Priority;
}

/** The user to assign a new ticket to (rules above), or null to leave it in the team's queue. */
export async function pickAutoAssignee(
  db: Prisma.TransactionClient | PrismaClient,
  input: AutoAssignInput,
): Promise<string | null> {
  if (AUTO_ASSIGN_SKIPS.includes(input.priority)) return null;

  const needed = await db.categorySkill.findMany({
    where: { categoryId: input.categoryId, skill: { isActive: true } },
    select: { skillId: true },
  });
  if (needed.length === 0) return null;

  const members = await db.teamMember.findMany({
    where: {
      teamId: input.teamId,
      user: {
        status: 'ACTIVE',
        role: { in: [...STAFF_ROLES] },
        acceptsAutoAssign: true,
        skills: {
          some: { skillId: { in: needed.map((n) => n.skillId) }, skill: { isActive: true } },
        },
      },
    },
    select: { userId: true },
  });
  if (members.length === 0) return null;
  const ids = members.map((m) => m.userId);

  const [open, lastAssigned] = await Promise.all([
    db.ticket.groupBy({
      by: ['assigneeId'],
      where: { assigneeId: { in: ids }, status: { in: [...ACTIVE_STATUSES] } },
      _count: { _all: true },
    }),
    db.ticketEvent.groupBy({
      by: ['toValue'],
      where: {
        type: 'ASSIGNEE_CHANGED',
        meta: { path: ['auto'], equals: true },
        toValue: { in: ids },
      },
      _max: { createdAt: true },
    }),
  ]);
  const openBy = new Map(open.map((row) => [row.assigneeId, row._count._all]));
  const lastBy = new Map(lastAssigned.map((row) => [row.toValue, row._max.createdAt]));

  const winner = chooseAssignee(
    ids.map((userId) => ({
      userId,
      openTickets: openBy.get(userId) ?? 0,
      lastAutoAssignedAt: lastBy.get(userId) ?? null,
    })),
  );
  return winner?.userId ?? null;
}
