import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import {
  TICKET_LIMITS,
  canSeeInternalNotes,
  canViewTicket,
  type Actor,
  type AttachmentDto,
  type UploadRejectionDetails,
  type UploadRejectionReason,
} from '@loons/shared';
import type { AppConfig } from '../config.ts';
import { errors, type ValidationIssue } from '../lib/errors.ts';
import type { AppLogger as Logger } from '../lib/logger.ts';
import { withTimeout } from '../lib/redis.ts';
import {
  SNIFF_BYTES,
  UPLOAD_KEY_PREFIX,
  buildStoredKey,
  buildUploadKey,
  contentMatchesMimeType,
  fileNameForMimeType,
  isAllowedMimeType,
  normalizeMimeType,
  s3Status,
  type ObjectHead,
  type Storage,
} from '../lib/storage.ts';
import {
  assertClientCanWrite,
  bodyIssue,
  isClosed,
  loadVisibleTicket,
  type Tx,
} from './ticket-access.ts';
import { attachmentSelect, toAttachmentDto } from './ticket-dto.ts';

// Attachments (spec §12): the browser uploads straight to S3/MinIO with a pre-signed POST
// (size range + exact Content-Type enforced by storage), then calls `complete`, which checks
// the object and runs the virus-scan hook. Files are linked to a message when it is posted.
//
// The pre-signed POST stays usable for 15 minutes, so the uploader could replace the object
// after it was checked (review SEC-ATT-1). `complete` therefore copies the checked object —
// pinned by its ETag — to a key only the API writes (`files/<attachmentId>/…`), deletes the
// upload, and sniffs, scans and serves only that copy. (Bucket versioning + VersionId would
// also work, but needs versioning enabled on every bucket and a VersionId in every signed GET.)
// A POST after that recreates the upload object, which nothing references: the upload prefix is
// transient — expired by a bucket lifecycle rule — and keyed by the attachment id so the e2e
// cleanup can sweep it with the row (review RR-SEC-4).

/** Pre-signed POST lifetime (contract: 15 min). */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Signed download URL lifetime (contract: 5 min). */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * How long one confirmation may hold its upload's lock: longer than any HEAD + copy (25 MB, same
 * bucket) + scan; a crashed holder's lock goes away after this.
 */
export const CONFIRM_LOCK_MS = 120_000;
/** How long a confirmation waits for Redis to grant the lock before it goes on without it. */
export const CONFIRM_LOCK_WAIT_MS = 2_000;
/** Answer to a confirmation while another one of the same upload runs (409; retry later). */
export const CONFIRM_IN_PROGRESS_MESSAGE =
  'This upload is already being checked; try again shortly';
/** Deletes the lock only while it is still ours (after an expiry someone else may hold it). */
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

/** Linkable: uploaded by the caller, confirmed (and not rejected by the scan), not yet linked. */
const LINKABLE_STATUSES = ['UPLOADED', 'CLEAN'] as const;

export interface PresignInput {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  ticketId?: string | undefined;
}

export interface PresignResult {
  attachmentId: string;
  upload: { url: string; fields: Record<string, string> };
  expiresAt: string;
}

export interface AttachmentsService {
  presign(actor: Actor, input: PresignInput): Promise<PresignResult>;
  complete(actor: Actor, attachmentId: string): Promise<AttachmentDto>;
  download(actor: Actor, attachmentId: string): Promise<{ url: string; expiresAt: string }>;
}

/**
 * Validation issues for linking `ids` (request order) to a new message of `ticketId` (null
 * while the ticket is being created): each must exist, be the caller's, be confirmed and not
 * linked elsewhere; at most 25 MB in total.
 */
export async function attachmentLinkIssues(
  db: PrismaClient | Tx,
  actor: Actor,
  ids: readonly string[],
  ticketId: string | null,
): Promise<ValidationIssue[]> {
  if (ids.length === 0) return [];
  const rows = await db.attachment.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: {
      id: true,
      uploaderId: true,
      status: true,
      messageId: true,
      ticketId: true,
      sizeBytes: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  let total = 0;
  ids.forEach((id, index) => {
    const row = byId.get(id);
    const usable =
      row &&
      !seen.has(id) &&
      row.uploaderId === actor.id &&
      (LINKABLE_STATUSES as readonly string[]).includes(row.status) &&
      row.messageId === null &&
      (row.ticketId === null || row.ticketId === ticketId);
    seen.add(id);
    if (!usable) {
      issues.push(bodyIssue(['attachmentIds', index], 'attachment'));
      return;
    }
    total += row.sizeBytes;
  });
  if (total > TICKET_LIMITS.attachmentsTotalMaxBytes) {
    issues.push(bodyIssue(['attachmentIds'], 'attachments_too_large', 'validation.tooLong'));
  }
  return issues;
}

/** Links checked attachments to a message; fails (rolling the transaction back) on a race. */
export async function linkAttachments(
  tx: Tx,
  actor: Actor,
  ids: readonly string[],
  ticketId: string,
  messageId: string,
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const { count } = await tx.attachment.updateMany({
    where: {
      id: { in: unique },
      uploaderId: actor.id,
      messageId: null,
      status: { in: [...LINKABLE_STATUSES] },
      OR: [{ ticketId: null }, { ticketId }],
    },
    data: { ticketId, messageId },
  });
  if (count !== unique.length) {
    throw errors.validation([bodyIssue(['attachmentIds'], 'attachment')]);
  }
}

export function createAttachmentsService(deps: {
  prisma: PrismaClient;
  /** The per-upload confirmation lock. */
  redis: Redis;
  storage: Storage;
  config: AppConfig;
  logger: Logger;
}): AttachmentsService {
  const { prisma, redis, storage, config, logger } = deps;

  /**
   * Runs `fn` while holding the upload's confirmation lock (Redis SET NX PX, released only by its
   * holder): one confirmation per upload at a time, so concurrent `complete` calls no longer each
   * copy the whole object (sweep: 30 calls made 30 server-side copies of one 8 MB file). The
   * others get 409 CONFIRM_IN_PROGRESS_MESSAGE at once. When Redis is unavailable the confirmation
   * goes on unlocked (fail open, like the presign limit): the database claim still keeps exactly
   * one copy; only the cost of the extra copies comes back. A lock that is taken only after its
   * wait timed out (ioredis queues the SET while it reconnects) is given back once the unlocked
   * run is over: nobody would release it, and every retry would get 409 for CONFIRM_LOCK_MS
   * (round-2 verify).
   */
  async function singleFlight<T>(attachmentId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${config.redisPrefix}attachment-confirm:${attachmentId}`;
    const token = randomUUID();
    const release = () =>
      redis.eval(RELEASE_LOCK, 1, key, token).then(
        () => undefined,
        (err: unknown) => {
          logger.warn({ err, attachmentId }, 'could not release a confirmation lock');
        },
      );
    const attempt = redis.set(key, token, 'PX', CONFIRM_LOCK_MS, 'NX');
    let locked: boolean;
    try {
      locked =
        (await withTimeout(attempt, CONFIRM_LOCK_WAIT_MS, 'attachment confirmation lock')) === 'OK';
    } catch (err) {
      logger.warn({ err, attachmentId }, 'confirmation lock unavailable; confirming without it');
      try {
        return await fn();
      } finally {
        void attempt.then(
          (reply) => (reply === 'OK' ? release() : undefined),
          () => undefined,
        );
      }
    }
    if (!locked) throw errors.conflict(CONFIRM_IN_PROGRESS_MESSAGE);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async function discard(key: string): Promise<void> {
    try {
      await storage.deleteObject(key);
    } catch (err) {
      logger.warn({ err }, 'could not delete an upload object');
    }
  }

  /** Marks the upload refused, deletes the object and answers 400 with `details.reason`. */
  async function reject(
    id: string,
    key: string,
    reason: UploadRejectionReason,
    message: string,
  ): Promise<never> {
    const status = reason === 'infected' ? 'INFECTED' : 'REJECTED';
    await prisma.attachment.update({ where: { id }, data: { status } });
    await discard(key);
    throw errors.badRequest(message, { reason } satisfies UploadRejectionDetails);
  }

  /**
   * PENDING → UPLOADED: checks the uploaded object and copies exactly that object (same ETag)
   * to a server-only key. Returns the key to scan and serve.
   */
  async function confirmUpload(row: {
    id: string;
    storageKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<string> {
    const uploadKey = row.storageKey;
    let head: ObjectHead | null;
    try {
      head = await storage.headObject(uploadKey);
    } catch (err) {
      // MinIO answers 400 for a key it refuses (e.g. a name segment over 255 bytes, which older
      // rows may still have): nothing usable is stored there — not uploaded, not a 500. Any other
      // status stays an error: a 401 / 403 is a credential or permission fault of the API (HEAD
      // needs s3:GetObject), which must page someone, not read as users' bad uploads (round-2
      // verify).
      if (s3Status(err) !== 400) throw err;
      logger.warn({ attachmentId: row.id, status: 400 }, 'storage refused to look up an upload');
      head = null;
    }
    if (!head) throw errors.conflict('The file has not been uploaded yet');
    const storedType = normalizeMimeType(head.contentType ?? '');
    if (head.sizeBytes !== row.sizeBytes || storedType !== row.mimeType) {
      return reject(
        row.id,
        uploadKey,
        'mismatch',
        'The uploaded file does not match its size or type',
      );
    }
    const storedKey = buildStoredKey(row.id, row.fileName);
    const copied = await storage.copyObject(uploadKey, storedKey, {
      ...(head.etag ? { ifMatch: head.etag } : {}),
    });
    // Replaced (or removed) between the check and the copy: check the new object on a retry.
    if (!copied) throw errors.conflict('The file changed while it was being checked; try again');
    const claimed = await prisma.attachment.updateMany({
      where: { id: row.id, status: { in: ['PENDING', 'UPLOADED'] }, storageKey: uploadKey },
      data: { status: 'UPLOADED', storageKey: storedKey },
    });
    if (claimed.count === 0) {
      // A concurrent confirmation won: keep its copy, drop ours.
      await discard(storedKey);
      const current = await prisma.attachment.findUniqueOrThrow({
        where: { id: row.id },
        select: { status: true, storageKey: true },
      });
      if (current.status !== 'UPLOADED' && current.status !== 'CLEAN') {
        throw errors.conflict('This upload was rejected');
      }
      return current.storageKey;
    }
    // The upload key is done with (a later POST there is never read).
    await discard(uploadKey);
    return storedKey;
  }

  return {
    async presign(actor, input) {
      const mimeType = normalizeMimeType(input.mimeType);
      const issues: ValidationIssue[] = [];
      if (!isAllowedMimeType(mimeType)) issues.push(bodyIssue(['mimeType'], 'file_type'));
      const maxBytes = Math.min(TICKET_LIMITS.attachmentMaxBytes, config.s3.uploadMaxBytes);
      if (input.sizeBytes > maxBytes) {
        issues.push(bodyIssue(['sizeBytes'], 'file_too_large', 'validation.tooLong'));
      }
      if (issues.length) throw errors.validation(issues);
      await assertClientCanWrite(prisma, actor);

      if (input.ticketId) {
        const ticket = await loadVisibleTicket(prisma, actor, input.ticketId);
        if (isClosed(ticket.status)) throw errors.conflict('This ticket is closed');
      }

      // The extension always belongs to the declared type (review SEC-ATT-2).
      const fileName = fileNameForMimeType(input.fileName, mimeType);
      const attachmentId = randomUUID();
      const storageKey = buildUploadKey(attachmentId, fileName);
      const post = await storage.createUploadPost({
        key: storageKey,
        contentType: mimeType,
        maxBytes: input.sizeBytes,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
      });
      const expiresAt = new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000);
      const row = await prisma.attachment.create({
        data: {
          id: attachmentId,
          ticketId: input.ticketId ?? null,
          uploaderId: actor.id,
          storageKey,
          fileName,
          mimeType,
          sizeBytes: input.sizeBytes,
          status: 'PENDING',
        },
        select: { id: true },
      });
      return {
        attachmentId: row.id,
        upload: { url: post.url, fields: post.fields },
        expiresAt: expiresAt.toISOString(),
      };
    },

    async complete(actor, attachmentId) {
      const load = async () => {
        const found = await prisma.attachment.findUnique({
          where: { id: attachmentId },
          select: { ...attachmentSelect, uploaderId: true, status: true, storageKey: true },
        });
        if (!found || found.uploaderId !== actor.id) throw errors.notFound('Attachment not found');
        return found;
      };
      const first = await load();
      if (first.status === 'CLEAN') return toAttachmentDto(first);
      if (first.status === 'INFECTED' || first.status === 'REJECTED') {
        throw errors.conflict('This upload was rejected');
      }
      return singleFlight(first.id, async () => {
        // Read again under the lock: a confirmation that held it before may have finished.
        const row = await load();
        if (row.status === 'CLEAN') return toAttachmentDto(row);
        if (row.status === 'INFECTED' || row.status === 'REJECTED') {
          throw errors.conflict('This upload was rejected');
        }
        // From here on only the server-only copy is read: its bytes can't change any more.
        // (An UPLOADED row still on its upload key predates the copy step: confirm it the same way.)
        const key =
          row.status === 'PENDING' || row.storageKey.startsWith(`${UPLOAD_KEY_PREFIX}/`)
            ? await confirmUpload(row)
            : row.storageKey;

        const head = await storage.readObjectStart(key, SNIFF_BYTES);
        if (!head) throw errors.conflict('The file has not been uploaded yet');
        if (!contentMatchesMimeType(row.mimeType, head)) {
          logger.warn({ attachmentId: row.id, mimeType: row.mimeType }, 'upload content mismatch');
          return reject(row.id, key, 'content', 'The file content does not match its type');
        }

        const scan = await storage.scanHook.scan({
          bucket: storage.bucket,
          key,
          contentType: row.mimeType,
          sizeBytes: row.sizeBytes,
        });
        switch (scan.verdict) {
          case 'CLEAN':
          case 'NOT_SCANNED':
            await prisma.attachment.update({ where: { id: row.id }, data: { status: 'CLEAN' } });
            return toAttachmentDto(row);
          case 'INFECTED':
            logger.warn({ attachmentId: row.id }, 'upload rejected by the virus scan');
            return reject(row.id, key, 'infected', 'This file was rejected by the virus scan');
          case 'ERROR':
            // Stays UPLOADED: the client may call complete again.
            logger.warn({ attachmentId: row.id }, 'virus scan failed; upload kept for a retry');
            throw errors.serviceUnavailable(30);
        }
      });
    },

    async download(actor, attachmentId) {
      const row = await prisma.attachment.findUnique({
        where: { id: attachmentId },
        select: {
          id: true,
          fileName: true,
          storageKey: true,
          status: true,
          uploaderId: true,
          messageId: true,
          message: { select: { type: true } },
          ticket: { select: { orgId: true, teamId: true, assigneeId: true } },
        },
      });
      const allowed =
        row &&
        (row.messageId === null
          ? // Not posted yet: only the uploader (e.g. previewing their own draft).
            row.uploaderId === actor.id
          : row.ticket !== null &&
            canViewTicket(actor, row.ticket) &&
            (row.message?.type !== 'INTERNAL' || canSeeInternalNotes(actor)));
      if (!row || !allowed) throw errors.notFound('Attachment not found');
      if (row.status === 'UPLOADED') throw errors.conflict('This file is still being checked');
      if (row.status !== 'CLEAN') throw errors.notFound('Attachment not found');

      const url = await storage.getDownloadUrl(row.storageKey, {
        fileName: row.fileName,
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      });
      return {
        url,
        expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      };
    },
  };
}
