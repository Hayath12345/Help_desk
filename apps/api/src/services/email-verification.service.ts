import type { PrismaClient } from '@loons/db';
import type { EmailTemplateKey, RenderedEmail } from '@loons/emails';
import {
  WEB_ROUTES,
  type AuthUser,
  type EmailLinkOwner,
  type Locale,
  type VerifyEmailInput,
} from '@loons/shared';
import type { AppConfig } from '../config.ts';
import { authUserSelect, toAuthUser, type PrincipalStore } from '../lib/actor.ts';
import { errors } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppQueues } from '../lib/queues.ts';
import {
  EMAIL_VERIFICATION_TOKEN_TTL_HOURS,
  generateOneTimeToken,
  hashToken,
} from '../lib/tokens.ts';
import { renderStoredTemplate } from './email-templates.ts';

// Client self-signup must prove mailbox ownership before the account can see its organisation's
// data (the org is matched on the email domain). Unverified clients can sign in, but every
// Bearer route except /me answers 403 EMAIL_NOT_VERIFIED until they open the emailed link.
//
// A link confirms the address only inside that account's own signed-in session (RR-SEC-1).
// Whoever registered the address chose its password; if the mailbox owner could confirm it while
// signed out, the registrant would keep a verified account on the owner's address. Signed out, the
// owner signs in first (or resets the password, which replaces it and ends every other session).

export const EMAIL_VERIFICATION_TEMPLATE_KEY = 'EMAIL_VERIFICATION' satisfies EmailTemplateKey;

export interface VerificationRecipient {
  id: string;
  email: string;
  name: string;
  locale: Locale;
}

export interface EmailVerificationService {
  /**
   * Issues a new verification link (the user's older unused links stop working) and queues the
   * email. Used right after sign-up.
   */
  sendVerification(user: VerificationRecipient, locale?: Locale): Promise<void>;
  /**
   * "Resend email" on /verify-email: sends a new link only to an existing, unverified CLIENT that
   * is not disabled; otherwise does nothing. Callers answer 202 regardless.
   */
  requestResend(input: { userId: string; locale?: Locale | undefined }): Promise<void>;
  /**
   * Which account a link is for, without using it up (the confirmation page shows who has to sign
   * in). Unknown, used or expired links (or a disabled account) → 400 VERIFY_TOKEN_INVALID.
   */
  describeLink(token: string): Promise<EmailLinkOwner>;
  /**
   * Consumes a link (single use) for the signed-in `userId`: marks the email verified, deletes the
   * user's other links and clears the cached principal. Unknown, used or expired links (or a
   * disabled account) → 400 VERIFY_TOKEN_INVALID; another account's link → 403
   * VERIFY_WRONG_ACCOUNT (the link stays usable).
   */
  verify(input: VerifyEmailInput): Promise<AuthUser>;
  /** Renders the email from the EmailTemplate row (or the built-in default). */
  renderVerificationEmail(args: {
    name: string;
    locale: Locale;
    verifyUrl: string;
  }): Promise<RenderedEmail>;
}

export function createEmailVerificationService(deps: {
  prisma: PrismaClient;
  queues: AppQueues;
  principals: PrincipalStore;
  config: Pick<AppConfig, 'appUrl'>;
  logger: Logger;
}): EmailVerificationService {
  const { prisma, queues, principals, config, logger } = deps;

  async function renderVerificationEmail({
    name,
    locale,
    verifyUrl,
  }: {
    name: string;
    locale: Locale;
    verifyUrl: string;
  }) {
    return renderStoredTemplate(prisma, EMAIL_VERIFICATION_TEMPLATE_KEY, {
      locale,
      // Same names as the seeded EMAIL_VERIFICATION row's `variables`.
      variables: { name, verifyUrl, expiresHours: EMAIL_VERIFICATION_TOKEN_TTL_HOURS },
      ctaUrl: verifyUrl,
    });
  }

  async function sendVerification(
    user: VerificationRecipient,
    locale: Locale = user.locale,
  ): Promise<void> {
    const { token, tokenHash } = generateOneTimeToken();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 3_600_000);
    const record = await prisma.$transaction(async (tx) => {
      // A new link invalidates every older unused one.
      await tx.emailVerificationToken.deleteMany({ where: { userId: user.id, usedAt: null } });
      return tx.emailVerificationToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
        select: { id: true },
      });
    });

    const verifyUrl = `${config.appUrl}${WEB_ROUTES.verifyEmailConfirm}?token=${encodeURIComponent(token)}`;
    const message = await renderVerificationEmail({ name: user.name, locale, verifyUrl });
    const jobId = await queues.enqueueEmail(
      {
        to: user.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tag: 'email-verification',
      },
      {
        jobId: `email-verification-${record.id}`,
        // The payload carries a live verification link: don't keep it in Redis once sent.
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      },
    );
    logger.info({ userId: user.id, jobId }, 'email verification queued');
  }

  async function requestResend(input: {
    userId: string;
    locale?: Locale | undefined;
  }): Promise<void> {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        locale: true,
        emailVerifiedAt: true,
      },
    });
    if (
      !user ||
      user.role !== 'CLIENT' ||
      user.status === 'DISABLED' ||
      user.emailVerifiedAt !== null
    ) {
      logger.debug(
        'verification email requested for an ineligible or unknown account; nothing sent',
      );
      return;
    }
    await sendVerification(user, input.locale ?? user.locale);
  }

  /** The unused, unexpired link of an account that is not disabled; else 400 VERIFY_TOKEN_INVALID. */
  async function usableLink(token: string, now: Date) {
    const record = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { email: true, status: true } },
      },
    });
    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt <= now ||
      record.user.status === 'DISABLED'
    ) {
      throw errors.verifyTokenInvalid();
    }
    return record;
  }

  async function describeLink(token: string): Promise<EmailLinkOwner> {
    const record = await usableLink(token, new Date());
    return { userId: record.userId, email: record.user.email };
  }

  async function verify({ token, userId }: VerifyEmailInput): Promise<AuthUser> {
    const now = new Date();
    const record = await usableLink(token, now);
    // Only the account's own session confirms its address (RR-SEC-1); the link stays usable.
    if (record.userId !== userId) throw errors.verifyWrongAccount();

    const user = await prisma.$transaction(async (tx) => {
      // Conditional claim: two concurrent requests with the same link can't both succeed.
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, userId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw errors.verifyTokenInvalid();
      await tx.user.updateMany({
        where: { id: record.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await tx.emailVerificationToken.deleteMany({
        where: { userId: record.userId, id: { not: record.id } },
      });
      return tx.user.findUniqueOrThrow({ where: { id: record.userId }, select: authUserSelect });
    });
    // After the commit, so the next request sees the verified principal.
    await principals.invalidate(record.userId);
    logger.info({ userId: record.userId }, 'email address verified');
    return toAuthUser(user);
  }

  return { sendVerification, requestResend, describeLink, verify, renderVerificationEmail };
}
