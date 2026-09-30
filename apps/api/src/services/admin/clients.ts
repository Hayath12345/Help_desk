import type { Prisma } from '@loons/db';
import {
  STAFF_ROLES,
  normalizeE164,
  type Actor,
  type AdminPagedQuery,
  type ApproveSignupInput,
  type ArchiveBody,
  type CreateOrganizationInput,
  type CreateSiteInput,
  type OrganizationAdminDto,
  type PendingSignupDto,
  type PendingSignupStatus,
  type RejectSignupInput,
  type ReorderBody,
  type SiteAdminDto,
  type UpdateOrganizationInput,
  type UpdateSiteInput,
} from '@loons/shared';
import { z } from 'zod';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { REVOKE_SESSIONS_DATA } from '../sessions.service.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockFresh } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import { generateKey } from './keys.ts';
import { applyReorder, writeSortOrder } from './reorder.ts';
import type { AdminContext, AfterCommit } from './write.ts';

// Admin — Clients & sites, pending sign-ups (spec §10.7; decision E10; super admins only).
// Contract: packages/shared/src/schemas/admin/clients.ts; routes: ../../routes/admin/clients.ts.
//
// - Email domains are lower-case hostnames, unique across every organisation (archived ones
//   included, checked under an advisory lock), never the staff domain or a public mail domain.
//   Sign-ups from a claimed domain join the organisation (auth: matchOrganizationByDomain).
// - The account manager must be an active staff member; the phone is stored in E.164.
// - Archiving an organisation removes nothing: its clients keep read access and can no longer
//   write (ticket-access assertClientCanWrite), new sign-ups stop matching it. Their principals
//   are invalidated so their sockets are re-checked.
// - Sites are ordered per organisation and archived, never deleted.
// - Pending sign-ups (PENDING_APPROVAL clients whose address matched no organisation): approve into
//   an active organisation (status ACTIVE) or reject (status DISABLED, sessions revoked). A rejected
//   sign-up (a DISABLED client without an organisation) stays listed under `status=rejected` and can
//   still be approved (audited APPROVE from DISABLED): rejecting by mistake, or rejecting an address
//   someone else registered first, is not final. No welcome email: there is no template for it (the
//   twelve email templates are fixed, E14).
// Scope `form-context` (form contexts, requester search, ticket details).

type Tx = Prisma.TransactionClient;
type Db = Tx | AdminDeps['prisma'];

export const CLIENT_GUARDS = { notPending: 'signup_not_pending' } as const;

const EMAIL_DOMAINS_LOCK = 'org-email-domains';

const siteSelect = {
  id: true,
  orgId: true,
  key: true,
  name: true,
  nameAr: true,
  address: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SiteSelect;

const orgSelect = {
  id: true,
  key: true,
  name: true,
  nameAr: true,
  contractType: true,
  amcExpiry: true,
  emailDomains: true,
  phone: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  accountManager: { select: { id: true, name: true } },
  sites: {
    select: siteSelect,
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
  },
  _count: { select: { users: { where: { role: 'CLIENT' } } } },
} satisfies Prisma.OrganizationSelect;

type OrgRow = Prisma.OrganizationGetPayload<{ select: typeof orgSelect }>;
type SiteRow = Prisma.SiteGetPayload<{ select: typeof siteSelect }>;

const signupSelect = {
  id: true,
  name: true,
  email: true,
  signupCompany: true,
  emailVerifiedAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  org: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;
type SignupRow = Prisma.UserGetPayload<{ select: typeof signupSelect }>;

/** The sign-ups of one list: waiting for a decision, or rejected (DISABLED, no organisation). */
function signupFilter(status: PendingSignupStatus): Prisma.UserWhereInput {
  return status === 'rejected'
    ? { role: 'CLIENT', status: 'DISABLED', orgId: null }
    : { role: 'CLIENT', status: 'PENDING_APPROVAL' };
}

const day = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);
const dateOf = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

export function toSiteDto(row: SiteRow): SiteAdminDto {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOrganizationDto(row: OrgRow): OrganizationAdminDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    nameAr: row.nameAr,
    contractType: row.contractType,
    amcExpiry: day(row.amcExpiry),
    accountManager: row.accountManager,
    emailDomains: row.emailDomains,
    phone: row.phone,
    isActive: row.isActive,
    sites: row.sites.map(toSiteDto),
    clientCount: row._count.users,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPendingSignupDto(row: SignupRow): PendingSignupDto {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailDomain: row.email.slice(row.email.lastIndexOf('@') + 1),
    signupCompany: row.signupCompany,
    emailVerified: row.emailVerifiedAt !== null,
    status: row.status,
    org: row.org,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function orgAudit(row: {
  key: string;
  name: string;
  nameAr: string | null;
  contractType: string;
  amcExpiry: Date | null;
  accountManagerId: string | null;
  emailDomains: string[];
  phone: string | null;
  isActive: boolean;
}) {
  return {
    key: row.key,
    name: row.name,
    nameAr: row.nameAr,
    contractType: row.contractType,
    amcExpiry: day(row.amcExpiry),
    accountManagerId: row.accountManagerId,
    emailDomains: row.emailDomains,
    phone: row.phone,
    isActive: row.isActive,
  };
}

function siteAudit(row: {
  orgId: string;
  key: string;
  name: string;
  nameAr: string | null;
  address: string | null;
  isActive: boolean;
}) {
  return {
    orgId: row.orgId,
    key: row.key,
    name: row.name,
    nameAr: row.nameAr,
    address: row.address,
    isActive: row.isActive,
  };
}

function issue(path: Array<string | number>, message: string, code: string): ValidationIssue {
  return { location: 'body', path, message, code };
}

/** An organisation phone as typed → E.164, null for none; 400 `validation.phone` otherwise. */
function orgPhone(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  const phone = normalizeE164(raw);
  if (!phone) throw errors.validation([issue(['phone'], 'validation.phone', 'phone')]);
  return phone;
}

// Keyset cursors: an opaque base64url JSON pair of the sort value and the id.
const cursorSchema = z.tuple([z.string(), z.uuid()]);

function encodeCursor(value: string, id: string): string {
  return Buffer.from(JSON.stringify([value, id]), 'utf8').toString('base64url');
}

const invalidCursor = () =>
  errors.validation([
    { location: 'querystring', path: ['cursor'], message: 'validation.invalid', code: 'cursor' },
  ]);

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  throw invalidCursor();
}

export interface PendingSignupQuery {
  status?: PendingSignupStatus | undefined;
  search?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface ClientsAdminService {
  list(
    actor: Actor,
    query: AdminPagedQuery,
  ): Promise<{ items: OrganizationAdminDto[]; nextCursor: string | null }>;
  create(ctx: AdminContext, input: CreateOrganizationInput): Promise<OrganizationAdminDto>;
  update(
    ctx: AdminContext,
    id: string,
    input: UpdateOrganizationInput,
  ): Promise<OrganizationAdminDto>;
  archive(ctx: AdminContext, id: string, body: ArchiveBody): Promise<OrganizationAdminDto>;
  restore(ctx: AdminContext, id: string, body: ArchiveBody): Promise<OrganizationAdminDto>;
  createSite(ctx: AdminContext, orgId: string, input: CreateSiteInput): Promise<SiteAdminDto>;
  updateSite(
    ctx: AdminContext,
    orgId: string,
    siteId: string,
    input: UpdateSiteInput,
  ): Promise<SiteAdminDto>;
  archiveSite(
    ctx: AdminContext,
    orgId: string,
    siteId: string,
    body: ArchiveBody,
  ): Promise<SiteAdminDto>;
  restoreSite(
    ctx: AdminContext,
    orgId: string,
    siteId: string,
    body: ArchiveBody,
  ): Promise<SiteAdminDto>;
  /** The organisation's active sites (archived ones keep their place after them). */
  reorderSites(ctx: AdminContext, orgId: string, body: ReorderBody): Promise<void>;
  pendingSignups(
    actor: Actor,
    query: PendingSignupQuery,
  ): Promise<{ items: PendingSignupDto[]; nextCursor: string | null }>;
  approveSignup(
    ctx: AdminContext,
    id: string,
    input: ApproveSignupInput,
  ): Promise<PendingSignupDto>;
  rejectSignup(ctx: AdminContext, id: string, input: RejectSignupInput): Promise<PendingSignupDto>;
}

export function createClientsAdminService(deps: AdminDeps): ClientsAdminService {
  const { prisma, writer, config } = deps;
  const staffDomain = config.staffEmailDomain.toLowerCase();

  async function loadOrg(db: Db, id: string): Promise<OrganizationAdminDto> {
    const row = await db.organization.findUnique({ where: { id }, select: orgSelect });
    if (!row) throw errors.notFound('Organisation not found');
    return toOrganizationDto(row);
  }

  async function loadSite(db: Db, orgId: string, siteId: string): Promise<SiteRow> {
    const row = await db.site.findUnique({ where: { id: siteId }, select: siteSelect });
    if (!row || row.orgId !== orgId) throw errors.notFound('Site not found');
    return row;
  }

  /** E10: never the staff domain; unique across every organisation (archived ones included). */
  async function checkDomains(tx: Tx, domains: string[], orgId: string | null): Promise<void> {
    const staffIndex = domains.findIndex((d) => d === staffDomain);
    if (staffIndex >= 0) {
      throw errors.validation([
        issue(['emailDomains', staffIndex], 'validation.staffEmailDomain', 'staff_domain'),
      ]);
    }
    if (domains.length === 0) return;
    await advisoryLock(tx, EMAIL_DOMAINS_LOCK);
    const other = await tx.organization.findFirst({
      where: { emailDomains: { hasSome: domains }, ...(orgId ? { id: { not: orgId } } : {}) },
      select: { id: true, isActive: true },
    });
    if (other) throw adminErrors.duplicate(['emailDomains'], other);
  }

  async function checkAccountManager(tx: Tx, userId: string | null): Promise<void> {
    if (userId === null) return;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true, role: true },
    });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !(STAFF_ROLES as readonly string[]).includes(user.role)
    ) {
      throw errors.validation([
        issue(['accountManagerId'], 'validation.activeStaff', 'active_staff'),
      ]);
    }
  }

  /** The organisation's clients: their principals (and sockets) are re-checked after commit. */
  async function invalidateClients(tx: Tx, orgId: string, after: AfterCommit): Promise<void> {
    const users = await tx.user.findMany({
      where: { orgId, role: 'CLIENT' },
      select: { id: true },
    });
    for (const user of users) after.invalidatePrincipal(user.id);
  }

  async function setOrgActive(
    ctx: AdminContext,
    id: string,
    body: ArchiveBody,
    isActive: boolean,
  ): Promise<OrganizationAdminDto> {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit, after }) => {
      await lockFresh(tx, 'Organization', id, body.expectedUpdatedAt);
      const before = await tx.organization.findUniqueOrThrow({ where: { id } });
      if (before.isActive === isActive) return loadOrg(tx, id);
      const row = await tx.organization.update({ where: { id }, data: { isActive } });
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Organization',
        entityId: id,
        entityLabel: row.name,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive },
      });
      await invalidateClients(tx, id, after);
      return loadOrg(tx, id);
    });
  }

  async function setSiteActive(
    ctx: AdminContext,
    orgId: string,
    siteId: string,
    body: ArchiveBody,
    isActive: boolean,
  ): Promise<SiteAdminDto> {
    requireSuperAdmin(ctx.actor);
    return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
      await lockFresh(tx, 'Site', siteId, body.expectedUpdatedAt);
      const before = await loadSite(tx, orgId, siteId);
      if (before.isActive === isActive) return toSiteDto(before);
      await tx.site.update({ where: { id: siteId }, data: { isActive } });
      const row = await loadSite(tx, orgId, siteId);
      await audit.record({
        action: isActive ? 'RESTORE' : 'ARCHIVE',
        entity: 'Site',
        entityId: siteId,
        entityLabel: row.name,
        before: { isActive: before.isActive },
        after: { isActive: row.isActive },
      });
      return toSiteDto(row);
    });
  }

  /**
   * Locks a sign-up waiting for a decision; with `rejectedToo`, also a rejected one (DISABLED, no
   * organisation — only rejectSignup makes a client that), which approving brings back.
   */
  async function lockPendingSignup(
    tx: Tx,
    id: string,
    expectedUpdatedAt: string,
    rejectedToo = false,
  ) {
    await lockFresh(tx, 'User', id, expectedUpdatedAt);
    const user = await tx.user.findUniqueOrThrow({
      where: { id },
      select: { id: true, name: true, role: true, status: true, orgId: true },
    });
    if (user.role !== 'CLIENT') throw errors.notFound('Sign-up not found');
    const open =
      user.status === 'PENDING_APPROVAL' ||
      (rejectedToo && user.status === 'DISABLED' && user.orgId === null);
    if (!open) {
      throw adminErrors.guard(
        CLIENT_GUARDS.notPending,
        'This sign-up was already approved or rejected.',
      );
    }
    return user;
  }

  async function loadSignup(tx: Tx, id: string): Promise<PendingSignupDto> {
    return toPendingSignupDto(
      await tx.user.findUniqueOrThrow({ where: { id }, select: signupSelect }),
    );
  }

  return {
    async list(actor, query) {
      requireSuperAdmin(actor);
      const after = decodeCursor(query.cursor);
      const term = query.search?.trim();
      const rows = await prisma.organization.findMany({
        where: {
          AND: [
            query.status === 'all' ? {} : { isActive: query.status === 'active' },
            term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' } },
                    { nameAr: { contains: term, mode: 'insensitive' } },
                    { key: { contains: term, mode: 'insensitive' } },
                    { emailDomains: { has: term.toLowerCase() } },
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
        select: orgSelect,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toOrganizationDto),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.name, last.id) : null,
      };
    },

    async create(ctx, input) {
      requireSuperAdmin(ctx.actor);
      const phone = orgPhone(input.phone);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
        await checkDomains(tx, input.emailDomains, null);
        await checkAccountManager(tx, input.accountManagerId);
        await advisoryLock(tx, 'key:Organization');
        let key = input.key;
        if (key) {
          const existing = await tx.organization.findUnique({
            where: { key },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        } else {
          key = await generateKey({
            label: input.name,
            fallbackPrefix: 'org',
            taken: async (candidates) =>
              (
                await tx.organization.findMany({
                  where: { key: { in: candidates } },
                  select: { key: true },
                })
              ).map((o) => o.key),
          });
        }
        const row = await tx.organization.create({
          data: {
            key,
            name: input.name,
            nameAr: input.nameAr,
            contractType: input.contractType,
            amcExpiry: dateOf(input.amcExpiry),
            accountManagerId: input.accountManagerId,
            emailDomains: input.emailDomains,
            phone,
          },
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Organization',
          entityId: row.id,
          entityLabel: row.name,
          after: orgAudit(row),
        });
        return loadOrg(tx, row.id);
      });
    },

    async update(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      const phone = input.phone === undefined ? undefined : orgPhone(input.phone);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Organization', id, input.expectedUpdatedAt);
        const before = await tx.organization.findUniqueOrThrow({ where: { id } });
        if (input.emailDomains !== undefined) await checkDomains(tx, input.emailDomains, id);
        if (
          input.accountManagerId !== undefined &&
          input.accountManagerId !== before.accountManagerId
        ) {
          await checkAccountManager(tx, input.accountManagerId);
        }
        const row = await tx.organization.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
            ...(input.contractType !== undefined ? { contractType: input.contractType } : {}),
            ...(input.amcExpiry !== undefined ? { amcExpiry: dateOf(input.amcExpiry) } : {}),
            ...(input.accountManagerId !== undefined
              ? { accountManagerId: input.accountManagerId }
              : {}),
            ...(input.emailDomains !== undefined ? { emailDomains: input.emailDomains } : {}),
            ...(phone !== undefined ? { phone } : {}),
          },
        });
        await audit.record({
          action: 'UPDATE',
          entity: 'Organization',
          entityId: id,
          entityLabel: row.name,
          before: orgAudit(before),
          after: orgAudit(row),
        });
        return loadOrg(tx, id);
      });
    },

    archive: (ctx, id, body) => setOrgActive(ctx, id, body, false),
    restore: (ctx, id, body) => setOrgActive(ctx, id, body, true),

    async createSite(ctx, orgId, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { id: true, name: true },
        });
        if (!org) throw errors.notFound('Organisation not found');
        await advisoryLock(tx, `key:Site:${orgId}`);
        let key = input.key;
        if (key) {
          const existing = await tx.site.findUnique({
            where: { orgId_key: { orgId, key } },
            select: { id: true, isActive: true },
          });
          if (existing) throw adminErrors.duplicate(['key'], existing);
        } else {
          key = await generateKey({
            label: input.name,
            fallbackPrefix: 'site',
            taken: async (candidates) =>
              (
                await tx.site.findMany({
                  where: { orgId, key: { in: candidates } },
                  select: { key: true },
                })
              ).map((s) => s.key),
          });
        }
        const last = await tx.site.aggregate({ where: { orgId }, _max: { sortOrder: true } });
        const row = await tx.site.create({
          data: {
            orgId,
            key,
            name: input.name,
            nameAr: input.nameAr === '' ? null : input.nameAr,
            address: input.address,
            sortOrder: (last._max.sortOrder ?? -1) + 1,
          },
          select: siteSelect,
        });
        await audit.record({
          action: 'CREATE',
          entity: 'Site',
          entityId: row.id,
          entityLabel: `${row.name} · ${org.name}`,
          after: siteAudit(row),
        });
        return toSiteDto(row);
      });
    },

    async updateSite(ctx, orgId, siteId, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
        await lockFresh(tx, 'Site', siteId, input.expectedUpdatedAt);
        const before = await loadSite(tx, orgId, siteId);
        await tx.site.update({
          where: { id: siteId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.nameAr !== undefined
              ? { nameAr: input.nameAr === '' ? null : input.nameAr }
              : {}),
            ...(input.address !== undefined ? { address: input.address } : {}),
          },
        });
        const row = await loadSite(tx, orgId, siteId);
        await audit.record({
          action: 'UPDATE',
          entity: 'Site',
          entityId: siteId,
          entityLabel: row.name,
          before: siteAudit(before),
          after: siteAudit(row),
        });
        return toSiteDto(row);
      });
    },

    archiveSite: (ctx, orgId, siteId, body) => setSiteActive(ctx, orgId, siteId, body, false),
    restoreSite: (ctx, orgId, siteId, body) => setSiteActive(ctx, orgId, siteId, body, true),

    async reorderSites(ctx, orgId, body) {
      requireSuperAdmin(ctx.actor);
      await writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit }) => {
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        });
        if (!org) throw errors.notFound('Organisation not found');
        const change = await applyReorder(tx, {
          list: `Site:${orgId}`,
          body,
          currentIds: async () =>
            (
              await tx.site.findMany({
                where: { orgId, isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
                select: { id: true },
              })
            ).map((s) => s.id),
          write: (ids) => writeSortOrder(tx, 'Site', ids),
        });
        if (change) {
          await audit.record({
            action: 'REORDER',
            entity: 'Site',
            entityId: orgId,
            entityLabel: org.name,
            before: { order: change.before },
            after: { order: change.after },
          });
        }
      });
    },

    async pendingSignups(actor, query) {
      requireSuperAdmin(actor);
      const after = decodeCursor(query.cursor);
      const afterDate = after ? new Date(after[0]) : null;
      if (afterDate && Number.isNaN(afterDate.getTime())) throw invalidCursor();
      const term = query.search?.trim();
      const rows = await prisma.user.findMany({
        where: {
          AND: [
            signupFilter(query.status ?? 'pending'),
            term
              ? {
                  OR: [
                    { name: { contains: term, mode: 'insensitive' } },
                    { email: { contains: term, mode: 'insensitive' } },
                    { signupCompany: { contains: term, mode: 'insensitive' } },
                  ],
                }
              : {},
            after && afterDate
              ? {
                  OR: [
                    { createdAt: { gt: afterDate } },
                    { createdAt: afterDate, id: { gt: after[1] } },
                  ],
                }
              : {},
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: query.limit + 1,
        select: signupSelect,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toPendingSignupDto),
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor(last.createdAt.toISOString(), last.id)
            : null,
      };
    },

    async approveSignup(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit, after }) => {
        const before = await lockPendingSignup(tx, id, input.expectedUpdatedAt, true);
        const org = await tx.organization.findUnique({
          where: { id: input.orgId },
          select: { id: true, name: true, isActive: true },
        });
        if (!org?.isActive) {
          throw errors.validation([
            issue(['orgId'], 'validation.activeOrganization', 'active_organization'),
          ]);
        }
        await tx.user.update({
          where: { id },
          data: { status: 'ACTIVE', orgId: org.id },
        });
        await audit.record({
          action: 'APPROVE',
          entity: 'User',
          entityId: id,
          entityLabel: before.name,
          before: { status: before.status, orgId: before.orgId },
          after: { status: 'ACTIVE', orgId: org.id },
        });
        after.invalidatePrincipal(id);
        return loadSignup(tx, id);
      });
    },

    async rejectSignup(ctx, id, input) {
      requireSuperAdmin(ctx.actor);
      return writer.write(ctx, { scopes: 'form-context' }, async ({ tx, audit, after }) => {
        const before = await lockPendingSignup(tx, id, input.expectedUpdatedAt);
        await tx.user.update({
          where: { id },
          data: { status: 'DISABLED', ...REVOKE_SESSIONS_DATA },
        });
        await audit.record({
          action: 'REJECT',
          entity: 'User',
          entityId: id,
          entityLabel: before.name,
          before: { status: before.status },
          after: { status: 'DISABLED' },
        });
        after.sessionsRevoked(id);
        return loadSignup(tx, id);
      });
    },
  };
}
