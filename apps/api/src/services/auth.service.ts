import {
  Prisma,
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
  type PrismaClient,
} from '@loons/db';
import {
  emailDomain,
  isStaffEmail,
  isStaffRole,
  normalizeEmail,
  type AuthUser,
  type LoginInput,
  type OAuthResolveInput,
  type RegisterInput,
} from '@loons/shared';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppConfig } from '../config.ts';
import { authUserSelect, toAuthUser, type AuthUserRow, type PrincipalStore } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';
import type { EmailVerificationService } from './email-verification.service.ts';
import { matchOrganizationByDomain } from './organizations.ts';
import { REVOKE_SESSIONS_DATA, type SessionsService } from './sessions.service.ts';

export interface AuthService {
  login(input: LoginInput): Promise<AuthUser>;
  resolveOAuth(input: OAuthResolveInput): Promise<AuthUser>;
  register(input: RegisterInput): Promise<AuthUser>;
  getUser(id: string): Promise<AuthUser>;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export function createAuthService(deps: {
  prisma: PrismaClient;
  config: Pick<AppConfig, 'staffEmailDomain' | 'devStaffLogin'>;
  principals: PrincipalStore;
  sessions: Pick<SessionsService, 'sessionsRevoked'>;
  verification: Pick<EmailVerificationService, 'sendVerification'>;
  logger: Logger;
}): AuthService {
  const { prisma, config, principals, sessions, verification, logger } = deps;
  const isStaffDomain = (email: string) => isStaffEmail(email, config.staffEmailDomain);

  async function login(input: LoginInput): Promise<AuthUser> {
    const email = normalizeEmail(input.email);

    // Decided by the domain alone (reveals nothing about which accounts exist).
    if (isStaffDomain(email) && (input.audience === 'client' || !config.devStaffLogin)) {
      throw errors.staffMustUseSso();
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { ...authUserSelect, passwordHash: true },
    });
    // Always run one argon2 verification so unknown emails and SSO-only accounts take as
    // long as a wrong password.
    const hash = user?.passwordHash ?? (await getDummyPasswordHash());
    const passwordOk = await verifyPassword(hash, input.password);
    if (!user || !user.passwordHash || !passwordOk) throw errors.invalidCredentials();

    if (user.status === 'DISABLED') throw errors.accountDisabled();
    if (isStaffRole(user.role)) {
      if (input.audience === 'client' || !config.devStaffLogin) throw errors.staffMustUseSso();
    } else if (input.audience === 'staff') {
      throw errors.clientPortalOnly();
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return toAuthUser(user);
  }

  async function findOAuthUser(input: OAuthResolveInput, email: string): Promise<AuthUserRow | null> {
    const linked = await prisma.authAccount.findUnique({
      where: {
        provider_providerAccountId: { provider: input.provider, providerAccountId: input.providerAccountId },
      },
      select: { user: { select: authUserSelect } },
    });
    if (linked) return linked.user;
    return prisma.user.findUnique({ where: { email }, select: authUserSelect });
  }

  /**
   * Links the provider identity (if new), records the sign-in and marks the email verified.
   * Google proves ownership of the mailbox, so an account whose address was never verified may
   * have been registered by someone else first (pre-hijacking): its password is removed and every
   * existing session, API token and socket is revoked, in the same transaction as the link.
   */
  async function linkAndTouch(user: AuthUserRow, input: OAuthResolveInput, email: string): Promise<AuthUserRow> {
    const now = new Date();
    let claimedUnverified = false;
    let becameVerified = false;
    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.authAccount.findUnique({
        where: {
          provider_providerAccountId: { provider: input.provider, providerAccountId: input.providerAccountId },
        },
        select: { userId: true },
      });
      if (!existing) {
        await tx.authAccount.create({
          data: { userId: user.id, provider: input.provider, providerAccountId: input.providerAccountId, email },
        });
      } else if (existing.userId !== user.id) {
        // The provider identity is already linked to another account; never re-link silently.
        throw errors.forbidden('This sign-in is linked to a different account.');
      }
      // Conditional updates (they only match while the address is still unverified), so the
      // decision can't race with a verification committing at the same time.
      if (input.provider === 'GOOGLE') {
        const claimed = await tx.user.updateMany({
          where: { id: user.id, emailVerifiedAt: null },
          data: { passwordHash: null, emailVerifiedAt: now, ...REVOKE_SESSIONS_DATA },
        });
        claimedUnverified = claimed.count === 1;
        if (claimedUnverified) await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } });
      } else {
        // Staff are gated by Entra itself; a successful sign-in also proves the address.
        const verified = await tx.user.updateMany({
          where: { id: user.id, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
        becameVerified = verified.count === 1;
      }
      return tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now }, select: authUserSelect });
    });
    if (claimedUnverified) {
      await sessions.sessionsRevoked(user.id);
      logger.info({ userId: user.id }, 'unverified account claimed with Google: password removed, sessions revoked');
    } else if (becameVerified) {
      await principals.invalidate(user.id);
    }
    return updated;
  }

  async function createGoogleClient(input: OAuthResolveInput, email: string): Promise<AuthUserRow> {
    const org = await matchOrganizationByDomain(prisma, emailDomain(email));
    const now = new Date();
    return prisma.user.create({
      data: {
        email,
        name: input.name.trim() || email.slice(0, email.indexOf('@')),
        role: 'CLIENT',
        status: org ? 'ACTIVE' : 'PENDING_APPROVAL',
        orgId: org?.id ?? null,
        locale: input.locale,
        emailVerifiedAt: now,
        lastLoginAt: now,
        accounts: {
          create: { provider: input.provider, providerAccountId: input.providerAccountId, email },
        },
      },
      select: authUserSelect,
    });
  }

  async function resolveOAuthOnce(input: OAuthResolveInput): Promise<AuthUser> {
    const email = normalizeEmail(input.email);
    const staffDomain = isStaffDomain(email);

    if (input.provider === 'GOOGLE') {
      if (staffDomain) throw errors.staffMustUseSso();
      if (!input.emailVerified) throw errors.emailNotVerified();
    } else if (!staffDomain) {
      throw errors.staffDomainRequired();
    }

    const user = await findOAuthUser(input, email);

    if (input.provider === 'MICROSOFT_ENTRA_ID') {
      // Staff accounts are provisioned by admins / the seed; SSO never creates them.
      if (!user || !isStaffRole(user.role)) {
        throw errors.forbidden('No Loons staff account exists for this Microsoft account.');
      }
      if (user.status === 'DISABLED') throw errors.accountDisabled();
      if (user.status !== 'ACTIVE') throw errors.forbidden('This staff account is not active.');
    } else if (user) {
      if (isStaffRole(user.role)) throw errors.staffMustUseSso();
      if (user.status === 'DISABLED') throw errors.accountDisabled();
    }

    if (!user) return toAuthUser(await createGoogleClient(input, email));
    return toAuthUser(await linkAndTouch(user, input, email));
  }

  async function resolveOAuth(input: OAuthResolveInput): Promise<AuthUser> {
    try {
      return await resolveOAuthOnce(input);
    } catch (err) {
      // Two first-time sign-ins racing on the same email / account: the loser retries once
      // and finds the row the winner created.
      if (isUniqueViolation(err)) return resolveOAuthOnce(input);
      throw err;
    }
  }

  async function register(input: RegisterInput): Promise<AuthUser> {
    const email = normalizeEmail(input.email);
    if (isStaffDomain(email)) throw errors.staffMustUseSso();

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw errors.emailTaken();

    const org = await matchOrganizationByDomain(prisma, emailDomain(email));
    const passwordHash = await hashPassword(input.password);
    const company = input.company.trim();
    let user: AuthUserRow;
    try {
      user = await prisma.user.create({
        data: {
          email,
          name: input.name.trim(),
          role: 'CLIENT',
          status: org ? 'ACTIVE' : 'PENDING_APPROVAL',
          orgId: org?.id ?? null,
          locale: input.locale,
          passwordHash,
          // Kept for the admin reviewing an unmatched sign-up.
          signupCompany: org ? null : company || null,
        },
        select: authUserSelect,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw errors.emailTaken();
      throw err;
    }
    // The account stays unverified (no data access) until the emailed link is opened. A queueing
    // failure doesn't undo the sign-up: /verify-email offers "Resend email".
    try {
      await verification.sendVerification(user);
    } catch (err) {
      logger.error({ err, userId: user.id }, 'could not queue the verification email');
    }
    return toAuthUser(user);
  }

  async function getUser(id: string): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id }, select: authUserSelect });
    if (!user) throw errors.notFound('User not found');
    return toAuthUser(user);
  }

  return { login, resolveOAuth, register, getUser };
}
