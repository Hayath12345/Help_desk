import type { Prisma } from '@loons/db';
import {
  STAFF_ROLES,
  isStaffEmail,
  normalizeE164,
  staffChangeProblem,
  staffChangeRevokesSessions,
  type Actor,
  type CreateStaffInput,
  type SetSkillsInput,
  type StaffAdminDto,
  type UpdateStaffInput,
} from '@loons/shared';
import { z } from 'zod';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { REVOKE_SESSIONS_DATA } from '../sessions.service.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { assertLinkableSkills, skillRefSelect, skillKeys, toSkillRefs } from './skills.ts';
import type { AdminContext } from './write.ts';

// Admin — Staff (decision E9; super admins only).
// Contract: packages/shared/src/schemas/admin/staff.ts; routes: ../../routes/admin/staff.ts.
//
// - Staff accounts are created here with an address on STAFF_EMAIL_DOMAIN and no password: the
//   first Microsoft sign-in finds the account by its address and links the Entra identity to it
//   (auth.service resolveOAuth → findOAuthUser / linkAndTouch).
// - Phones are stored in E.164 (`normalizeE164`), anything else is 400 `validation.phone`.
// - A role or status change bumps `sessionVersion` in the same transaction and, after commit,
//   clears the principal and closes the user's sockets (`sessionsRevoked`).
// - Nobody changes their own role or disables themselves, and the last active super admin stays:
//   the count is taken under an advisory lock, so two admins demoting each other can't both pass.
// Scope `staff` (pickers, team members).

const LAST_SUPER_ADMIN_LOCK = 'staff:active-super-admins';

const staffSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  jobTitle: true,
  phone: true,
  acceptsAutoAssign: true,
  skills: { select: { skill: { select: skillRefSelect } } },
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  teamMemberships: {
    select: {
      role: true,
      team: { select: { id: true, key: true, nameEn: true, nameAr: true, isActive: true } },
    },
  },
  accounts: { where: { provider: 'MICROSOFT_ENTRA_ID' }, select: { id: true }, take: 1 },
} satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof staffSelect }>;

const isStaffRole = (role: string): role is (typeof STAFF_ROLES)[number] =>
  (STAFF_ROLES as readonly string[]).includes(role);

export function toStaffDto(row: StaffRow): StaffAdminDto {
  if (!isStaffRole(row.role)) throw errors.notFound('Staff member not found');
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    jobTitle: row.jobTitle,
    phone: row.phone,
    phoneValid: normalizeE164(row.phone) !== null,
    teams: row.teamMemberships
      .map((m) => ({ ...m.team, memberRole: m.role }))
      .sort(
        (a, b) =>
          Number(b.isActive) - Number(a.isActive) ||
          a.nameEn.localeCompare(b.nameEn) ||
          a.id.localeCompare(b.id),
      ),
    skills: toSkillRefs(row.skills.map((s) => s.skill)),
    acceptsAutoAssign: row.acceptsAutoAssign,
    microsoftLinked: row.accounts.length > 0,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields of a staff account the audit log compares (the phone is masked there). */
function auditFields(row: {
  email: string;
  name: string;
  role: string;
  status: string;
  jobTitle: string | null;
  phone: string | null;
  acceptsAutoAssign: boolean;
}) {
  return {
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    jobTitle: row.jobTitle,
    phone: row.phone,
    acceptsAutoAssign: row.acceptsAutoAssign,
  };
}

function issue(path: Array<string | number>, message: string, code: string): ValidationIssue {
  return { location: 'body', path, message, code };
}

/** A phone as typed → E.164, null for none; 400 `validation.phone` for anything else. */
export function staffPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const phone = normalizeE164(raw);
  if (!phone) throw errors.validation([issue(['phone'], 'validation.phone', 'phone')]);
  return phone;
}

// Keyset cursor over (name, id): an opaque base64url JSON pair.
const cursorSchema = z.tuple([z.string(), z.uuid()]);

export function encodeNameCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id]), 'utf8').toString('base64url');
}

export function decodeNameCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw errors.validation([
    { location: 'querystring', path: ['cursor'], message: 'validation.invalid', code: 'cursor' },
  ]);
}

export interface StaffListQuery {
  status: 'active' | 'archived' | 'all';
  role?: (typeof STAFF_ROLES)[number] | undefined;
  search?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface StaffAdminService {
  list(
    actor: Actor,
    query: StaffListQuery,
  ): Promise<{ items: StaffAdminDto[]; nextCursor: string | null }>;
  create(ctx: AdminContext, input: CreateStaffInput): Promise<StaffAdminDto>;
  update(ctx: AdminContext, id: string, input: UpdateStaffInput): Promise<StaffAdminDto>;
  /** Replaces the skills the person has (docs/AUTO_ASSIGN.md). */
  setSkills(ctx: AdminContext, id: string, input: SetSkillsInput): Promise<StaffAdminDto>;
}

export function createStaffAdminService(deps: AdminDeps): StaffAdminService {
  const { prisma, writer, config } = deps;

  async function load(db: Prisma.TransactionClient | typeof prisma, id: string) {
    const row = await db.user.findUnique({ where: { id }, select: staffSelect });
    if (!row) throw errors.notFound('Staff member not found');
    return toStaffDto(row);
  }

  return {
    async list(actor, query) {
      requireSuperAdmin(actor);
      const after = decodeNameCursor(query.cursor);
      const term = query.search?.trim();
      const rows = await prisma.user.findMany({
        where: {
          AND: [
            { role: query.role ? query.role : { in: [...STAFF_ROLES] } },
            query.status === 'all'
              ? {}
              : query.status === 'active'
                ? { status: 'ACTIVE' }
                : { status: 'DISABLED' },
            term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' } },
                    { email: { contains: term, mode: 'insensitive' } },
                    { jobTitle: { contains: term, mode: 'insensitive' } },
                  ],
                }
              : {},
            after
              ? { OR: [{ name: { gt: after[0] } }, { name: after[0], id: { gt: after[1] } }] }
              : {},
          ],
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        select: staffSelect,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toStaffDto),
        nextCursor: rows.length > query.limit && last ? encodeNameCursor(last.name, last.id) : null,
      };
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      if (!isStaffEmail(input.email, config.staffEmailDomain)) {
        throw errors.validation([issue(['email'], 'validation.staffDomain', 'staff_domain')]);
      }
      const phone = staffPhone(input.phone);
      return writer.write(ctx, { scopes: 'staff' }, async ({ tx, audit }) => {
        const existing = await tx.user.findUnique({
          where: { email: input.email },
          select: { id: true },
        });
        if (existing) throw errors.emailTaken();
        let row;
        try {
          row = await tx.user.create({
            data: {
              email: input.email,
              name: input.name,
              role: input.role,
              status: 'ACTIVE',
              jobTitle: input.jobTitle,
              phone,
              // No password: staff sign in with Microsoft, which links to this account.
              passwordHash: null,
            },
            select: { id: true },
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002') throw errors.emailTaken();
          throw err;
        }
        const created = await load(tx, row.id);
        await audit.record({
          action: 'CREATE',
          entity: 'User',
          entityId: row.id,
          entityLabel: created.name,
          after: auditFields(created),
        });
        return created;
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      const phone = input.phone === undefined ? undefined : staffPhone(input.phone);
      const changesAccess = input.role !== undefined || input.status !== undefined;
      return writer.write(ctx, { scopes: 'staff' }, async ({ tx, audit, after }) => {
        // Taken before the row lock, in the same order by every writer (no deadlock).
        if (changesAccess) await advisoryLock(tx, LAST_SUPER_ADMIN_LOCK);
        await lockFresh(tx, 'User', id, input.expectedUpdatedAt);
        const before = await tx.user.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            status: true,
            jobTitle: true,
            phone: true,
            acceptsAutoAssign: true,
          },
        });
        if (!isStaffRole(before.role)) throw errors.notFound('Staff member not found');
        const next = { role: input.role ?? before.role, status: input.status ?? before.status };
        if (changesAccess) {
          const activeSuperAdmins = await tx.user.count({
            where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
          });
          const problem = staffChangeProblem(ctx.actor, before, next, activeSuperAdmins);
          if (problem) {
            throw adminErrors.guard(
              problem,
              problem === 'self_role'
                ? 'You can’t change your own role.'
                : problem === 'self_disable'
                  ? 'You can’t disable your own account.'
                  : 'This is the last active super admin. Make someone else a super admin first.',
            );
          }
        }
        const revoke = staffChangeRevokesSessions(before, next);
        await tx.user.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.role !== undefined ? { role: input.role } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
            ...(phone !== undefined ? { phone } : {}),
            ...(input.acceptsAutoAssign !== undefined
              ? { acceptsAutoAssign: input.acceptsAutoAssign }
              : {}),
            ...(revoke ? REVOKE_SESSIONS_DATA : {}),
          },
        });
        const updated = await load(tx, id);
        await audit.record({
          action: 'UPDATE',
          entity: 'User',
          entityId: id,
          entityLabel: updated.name,
          before: auditFields(before),
          after: auditFields(updated),
        });
        if (revoke) after.sessionsRevoked(id);
        return updated;
      });
    },

    async setSkills(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: ['staff', 'skills'] }, async ({ tx, audit }) => {
        await lockFresh(tx, 'User', id, input.expectedUpdatedAt);
        const before = await load(tx, id); // 404 for a client account too (toStaffDto)
        const current = before.skills.map((s) => s.id);
        await assertLinkableSkills(tx, input.skillIds, current);
        const wanted = new Set(input.skillIds);
        const drop = current.filter((skillId) => !wanted.has(skillId));
        const add = input.skillIds.filter((skillId) => !current.includes(skillId));
        if (drop.length > 0) {
          await tx.userSkill.deleteMany({ where: { userId: id, skillId: { in: drop } } });
        }
        if (add.length > 0) {
          await tx.userSkill.createMany({
            data: add.map((skillId) => ({ userId: id, skillId })),
          });
        }
        // The links are not columns of the user: touch the row so concurrent edits see the change.
        await tx.user.update({ where: { id }, data: { updatedAt: new Date() } });
        const updated = await load(tx, id);
        await audit.record({
          action: 'UPDATE',
          entity: 'User',
          entityId: id,
          entityLabel: updated.name,
          before: { skills: skillKeys(before.skills) },
          after: { skills: skillKeys(updated.skills) },
        });
        return updated;
      });
    },
  };
}
