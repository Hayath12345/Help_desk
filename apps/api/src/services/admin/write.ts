import type { Prisma, PrismaClient } from '@loons/db';
import type { Actor, ConfigScope } from '@loons/shared';
import type { PrincipalStore } from '../../lib/actor.ts';
import type { AppLogger as Logger } from '../../lib/logger.ts';
import type { SessionsService } from '../sessions.service.ts';
import { createAuditRecorder, type AuditRecorder } from './audit.ts';
import type { ConfigChanges } from './config-changes.ts';

// Every admin write goes through `writer.write` (decisions E17, E18, E19):
//
//   const item = await admin.writer.write(ctx, { scopes: 'ticket-form' }, async ({ tx, audit, after }) => {
//     await lockFresh(tx, 'Category', id, input.expectedUpdatedAt);           // 404 / 409 stale
//     const before = await tx.category.findUniqueOrThrow({ where: { id } });
//     const row = await tx.category.update({ where: { id }, data });
//     await audit.record({ action: 'UPDATE', entity: 'Category', entityId: id,
//                          entityLabel: row.labelEn, before, after: row });
//     return row;
//   });
//
// 1. `work` runs in ONE Prisma transaction; the audit rows it records are part of it, so a failed
//    change leaves no audit row and a failed audit insert undoes the change.
// 2. After COMMIT: queued principal invalidations / session revocations / other effects run (their
//    errors are logged, never thrown — the change is saved), then `afterConfigChange(scopes)`
//    bumps the config version and broadcasts `config:updated` to every socket.
// 3. If `work` throws, nothing after the transaction runs and the error reaches the caller.

export interface AdminContext {
  actor: Actor;
  /** The request id (x-request-id), stored on audit rows. */
  requestId: string;
}

export interface AfterCommit {
  /**
   * The user's teams, role, organisation or status changed: clear their cached principal and
   * re-check their live sockets (rooms) on every instance.
   */
  invalidatePrincipal(userId: string): void;
  /**
   * The transaction applied `REVOKE_SESSIONS_DATA` to the user: clear the principal and close
   * their live sockets.
   */
  sessionsRevoked(userId: string): void;
  /** Also announce this scope (on top of the write's `scopes`). */
  scope(scope: ConfigScope): void;
  /** Any other post-commit work (e.g. re-time queued jobs). Errors are logged, never thrown. */
  run(label: string, effect: () => Promise<void> | void): void;
}

export interface AdminWriteTools {
  tx: Prisma.TransactionClient;
  audit: AuditRecorder;
  after: AfterCommit;
  ctx: AdminContext;
}

export interface AdminWriteOptions {
  /** What the change touched (E18): announced with `config:updated` after commit. */
  scopes: ConfigScope | readonly ConfigScope[];
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Transaction timeout (default 10 s). */
  timeoutMs?: number;
}

export interface AdminWriter {
  write<T>(
    ctx: AdminContext,
    options: AdminWriteOptions,
    work: (tools: AdminWriteTools) => Promise<T>,
  ): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createAdminWriter(deps: {
  prisma: PrismaClient;
  principals: Pick<PrincipalStore, 'invalidate'>;
  sessions: Pick<SessionsService, 'sessionsRevoked'>;
  configChanges: ConfigChanges;
  logger: Logger;
}): AdminWriter {
  const { prisma, principals, sessions, configChanges, logger } = deps;

  return {
    async write(ctx, options, work) {
      const invalidate = new Set<string>();
      const revoked = new Set<string>();
      const scopes = new Set<ConfigScope>(
        typeof options.scopes === 'string' ? [options.scopes] : options.scopes,
      );
      const effects: Array<{ label: string; effect: () => Promise<void> | void }> = [];
      const after: AfterCommit = {
        invalidatePrincipal: (userId) => void invalidate.add(userId),
        sessionsRevoked: (userId) => void revoked.add(userId),
        scope: (scope) => void scopes.add(scope),
        run: (label, effect) => void effects.push({ label, effect }),
      };

      const result = await prisma.$transaction(
        (tx) =>
          work({
            tx,
            audit: createAuditRecorder(tx, { actorId: ctx.actor.id, requestId: ctx.requestId }),
            after,
            ctx,
          }),
        {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
        },
      );

      // Committed.
      for (const userId of revoked) {
        try {
          await sessions.sessionsRevoked(userId);
        } catch (err) {
          logger.error(
            { err, userId },
            'could not finish a session revocation after an admin change',
          );
        }
      }
      for (const userId of invalidate) {
        if (revoked.has(userId)) continue; // sessionsRevoked already invalidated it
        try {
          await principals.invalidate(userId);
        } catch (err) {
          logger.error({ err, userId }, 'could not invalidate a principal after an admin change');
        }
      }
      for (const { label, effect } of effects) {
        try {
          await effect();
        } catch (err) {
          logger.error({ err, effect: label }, 'an effect after an admin change failed');
        }
      }
      if (scopes.size > 0) await configChanges.afterConfigChange([...scopes]);
      return result;
    },
  };
}
