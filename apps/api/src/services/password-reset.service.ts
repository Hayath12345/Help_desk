import { hashPassword, type PrismaClient } from '@loons/db';
import type { EmailTemplateKey, RenderedEmail } from '@loons/emails';
import { normalizeEmail, type ForgotPasswordInput, type Locale, type ResetPasswordInput } from '@loons/shared';
import type { AppLogger as Logger } from '../lib/logger.ts';
import type { AppConfig } from '../config.ts';
import { errors } from '../lib/errors.ts';
import type { AppQueues } from '../lib/queues.ts';
import { RESET_TOKEN_TTL_MINUTES, generateOneTimeToken, hashToken } from '../lib/tokens.ts';
import { renderStoredTemplate } from './email-templates.ts';
import { REVOKE_SESSIONS_DATA, type SessionsService } from './sessions.service.ts';

export const PASSWORD_RESET_TEMPLATE_KEY = 'PASSWORD_RESET' satisfies EmailTemplateKey;

export interface PasswordResetService {
  /**
   * Issues a reset token and queues the email — only for existing CLIENT accounts that are not
   * disabled. Callers answer 202 regardless and should run this after responding.
   */
  requestReset(input: ForgotPasswordInput): Promise<void>;
  /**
   * Consumes a token (single use), sets the new password, marks the email verified and revokes
   * every existing session, API token and live socket of the user (sessionVersion + 1, same
   * transaction).
   */
  resetPassword(input: ResetPasswordInput): Promise<void>;
  /** Renders the reset email from the EmailTemplate row (or the built-in default). */
  renderResetEmail(args: { name: string; locale: Locale; resetUrl: string }): Promise<RenderedEmail>;
}

export function createPasswordResetService(deps: {
  prisma: PrismaClient;
  queues: AppQueues;
  sessions: Pick<SessionsService, 'sessionsRevoked'>;
  config: Pick<AppConfig, 'appUrl'>;
  logger: Logger;
}): PasswordResetService {
  const { prisma, queues, sessions, config, logger } = deps;

  async function renderResetEmail({ name, locale, resetUrl }: { name: string; locale: Locale; resetUrl: string }) {
    return renderStoredTemplate(prisma, PASSWORD_RESET_TEMPLATE_KEY, {
      locale,
      // Same names as the seeded PASSWORD_RESET row's `variables`.
      variables: { name, resetUrl, expiresMinutes: RESET_TOKEN_TTL_MINUTES },
      ctaUrl: resetUrl,
    });
  }

  async function requestReset(input: ForgotPasswordInput): Promise<void> {
    const email = normalizeEmail(input.email);
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, role: true, status: true, locale: true },
    });
    if (!user || user.role !== 'CLIENT' || user.status === 'DISABLED') {
      logger.debug('password reset requested for an ineligible or unknown account; nothing sent');
      return;
    }

    const { token, tokenHash } = generateOneTimeToken();
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000);
    const record = await prisma.$transaction(async (tx) => {
      // A new request invalidates every older unused token.
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
      return tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt },
        select: { id: true },
      });
    });

    const resetUrl = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const message = await renderResetEmail({ name: user.name, locale: user.locale, resetUrl });
    const jobId = await queues.enqueueEmail(
      { to: email, subject: message.subject, html: message.html, text: message.text, tag: 'password-reset' },
      {
        jobId: `password-reset-${record.id}`,
        // The payload carries a live reset link: don't keep it in Redis once sent.
        removeOnComplete: true,
        removeOnFail: { age: 24 * 3600 },
      },
    );
    logger.info({ userId: user.id, jobId }, 'password reset email queued');
  }

  async function resetPassword(input: ResetPasswordInput): Promise<void> {
    const now = new Date();
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: { select: { role: true, status: true, emailVerifiedAt: true } },
      },
    });
    if (
      !record ||
      record.usedAt !== null ||
      record.expiresAt <= now ||
      record.user.role !== 'CLIENT' ||
      record.user.status === 'DISABLED'
    ) {
      throw errors.resetTokenInvalid();
    }

    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction(async (tx) => {
      // Conditional claim: two concurrent requests with the same token can't both succeed.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw errors.resetTokenInvalid();
      await tx.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          // Whoever knew the old password is signed out everywhere.
          ...REVOKE_SESSIONS_DATA,
          ...(record.user.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
      });
      await tx.passwordResetToken.deleteMany({ where: { userId: record.userId, usedAt: null } });
    });
    // After the commit, so no request can re-cache the old sessionVersion; also closes their sockets.
    await sessions.sessionsRevoked(record.userId);
    logger.info({ userId: record.userId }, 'password reset completed; existing sessions revoked');
  }

  return { requestReset, resetPassword, renderResetEmail };
}
