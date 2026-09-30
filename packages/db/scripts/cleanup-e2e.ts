// Deletes the accounts and tickets the Playwright suite created (and the rows that depend on
// them), so repeated `pnpm test:e2e` runs don't pile up clients or tickets in the seeded
// organisations — and the stored files of their attachments (review P2-CC-6), their notification
// deliveries / in-app notifications and their queued or delayed BullMQ jobs (Phase 3: nothing of
// a removed ticket fires later), and (Phase 4) the config rows the admin spec created — keys of
// the exact shape it generates, `e2e-<Date.now()>[-panel]`: categories with their sub-types and
// field links, custom fields — after which the config cache is busted. Run by the Playwright
// global teardown:
// `pnpm --filter @loons/db db:cleanup-e2e`.
// Development / test databases only.
import { S3Client } from '@aws-sdk/client-s3';
import { isNonProductionEnv } from '../prisma/seed-data/options.ts';
import { createPrismaClient, type Prisma } from '../src/index.ts';
import { bustConfigCache, removeE2eConfig } from './e2e-config.ts';
import { attachmentObjectTargets, deleteObjects, s3FromEnv } from './e2e-objects.ts';
import { e2eTicketWhere, e2eUserWhere, isE2eTicket } from './e2e-users.ts';

async function main(): Promise<void> {
  // Allow-list, like the seed: only development / test databases (the script defaults to test).
  if (!isNonProductionEnv()) throw new Error('only runs with NODE_ENV=development or test');

  const db = createPrismaClient({ poolSize: 2 });
  try {
    // Tickets the suite raised as a seeded demo client (the client account stays).
    const candidates = await db.ticket.findMany({
      where: e2eTicketWhere(),
      select: { id: true, subject: true, requester: { select: { email: true } } },
    });
    const e2eTicketIds = candidates
      .filter((t) => isE2eTicket({ subject: t.subject, requesterEmail: t.requester.email }))
      .map((t) => t.id);
    const users = await db.user.findMany({ where: e2eUserWhere(), select: { id: true } });
    const ids = users.map((u) => u.id);

    // Their files first: once the rows are gone nothing points at the objects any more.
    const attachmentWhere: Prisma.AttachmentWhereInput = {
      OR: [
        { ticketId: { in: e2eTicketIds } },
        { uploaderId: { in: ids } },
        { ticket: { requesterId: { in: ids } } },
      ],
    };
    const attachments =
      e2eTicketIds.length || ids.length
        ? await db.attachment.findMany({
            where: attachmentWhere,
            select: { id: true, storageKey: true },
          })
        : [];
    // Queued / delayed notification and escalation jobs of those tickets (the worker would find
    // the tickets gone and do nothing; this keeps the queues clean).
    const userTicketIds = ids.length
      ? (
          await db.ticket.findMany({ where: { requesterId: { in: ids } }, select: { id: true } })
        ).map((t) => t.id)
      : [];
    const jobs = await removeQueuedJobs([...e2eTicketIds, ...userTicketIds]);

    let objects = 0;
    if (attachments.length) {
      const s3 = s3FromEnv();
      if (!s3) throw new Error('S3_BUCKET / S3_REGION are not set: cannot remove the e2e files');
      const client = new S3Client(s3.config);
      try {
        objects = await deleteObjects(client, s3.bucket, attachmentObjectTargets(attachments));
      } finally {
        client.destroy();
      }
    }

    const deleted = await db.$transaction(async (tx) => {
      // Their notification log and in-app notifications (these also cascade with the tickets).
      const notificationScope = {
        OR: [{ ticketId: { in: [...e2eTicketIds, ...userTicketIds] } }, { userId: { in: ids } }],
      };
      await tx.notificationDelivery.deleteMany({ where: notificationScope });
      await tx.notification.deleteMany({ where: notificationScope });
      // Ticket children (messages, events, tags, attachment rows, SLA signals) cascade.
      const suiteTickets = e2eTicketIds.length
        ? await tx.ticket.deleteMany({ where: { id: { in: e2eTicketIds } } })
        : { count: 0 };
      if (ids.length === 0) return { users: 0, tickets: suiteTickets.count };
      // Rows that would block the delete (onDelete: Restrict). Ticket children cascade; accounts,
      // tokens, memberships and notifications cascade from the user.
      await tx.attachment.deleteMany({ where: { uploaderId: { in: ids } } });
      const tickets = await tx.ticket.deleteMany({ where: { requesterId: { in: ids } } });
      const removed = await tx.user.deleteMany({ where: { id: { in: ids } } });
      return { users: removed.count, tickets: suiteTickets.count + tickets.count };
    });
    process.stdout.write(
      `[cleanup-e2e] removed ${deleted.users} e2e user(s), ${deleted.tickets} ticket(s), ${objects} stored file(s) and ${jobs} queued job(s)\n`,
    );

    // Config rows of the admin spec (after the tickets: a category still in use can't go).
    const config = await removeE2eConfig(db);
    const busted = await bustCache(config.categories + config.fields > 0);
    process.stdout.write(
      `[cleanup-e2e] removed ${config.categories} e2e category(ies) and ${config.fields} custom field(s)${busted ? '; config cache busted' : ''}\n`,
    );
    if (config.keptCategories.length) {
      console.warn(
        `[cleanup-e2e] kept e2e categories still used by other tickets: ${config.keptCategories.join(', ')}`,
      );
    }
    if (config.keptFields.length) {
      console.warn(
        `[cleanup-e2e] kept e2e custom fields other tickets hold values for: ${config.keptFields.join(', ')}`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

/** BullMQ prefix of the API and the worker (`<redisPrefix>bull`, AppConfig.redisPrefix "loons:"). */
const E2E_QUEUE_PREFIX = 'loons:bull';

/** Removes the tickets' waiting / delayed jobs (none when REDIS_URL is not set). */
async function removeQueuedJobs(ticketIds: string[]): Promise<number> {
  if (ticketIds.length === 0) return 0;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    console.warn('[cleanup-e2e] REDIS_URL is not set: queued jobs of the e2e tickets were kept');
    return 0;
  }
  // The helper lives next to the queues in the API (bullmq is its dependency, not this package's).
  const { removeTicketJobs } = await import('../../../apps/api/src/lib/job-cleanup.ts');
  return removeTicketJobs({
    connection: { ...redisConnection(url), maxRetriesPerRequest: null },
    prefix: E2E_QUEUE_PREFIX,
    ticketIds,
  });
}

/** Key prefix of the API and the worker (AppConfig.redisPrefix, "loons:"). */
const E2E_REDIS_PREFIX = 'loons:';

/**
 * Busts the API's config cache (generation bump, cached form config dropped) so no API instance
 * keeps serving the removed rows. Returns whether it ran.
 */
async function bustCache(changed: boolean): Promise<boolean> {
  if (!changed) return false;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    console.warn(
      '[cleanup-e2e] REDIS_URL is not set: the config cache expires on its own (≤ 5 min)',
    );
    return false;
  }
  // ioredis is the API's dependency; its Redis helper is self-contained.
  const { createRedisClient, closeRedis } = await import('../../../apps/api/src/lib/redis.ts');
  const redis = createRedisClient(url, undefined, 'e2e-cleanup');
  try {
    await bustConfigCache(redis, E2E_REDIS_PREFIX);
    return true;
  } finally {
    await closeRedis(redis);
  }
}

/** ioredis options for a redis:// or rediss:// URL. */
function redisConnection(url: string) {
  const { protocol, hostname, port, username, password, pathname } = new URL(url);
  return {
    host: hostname,
    port: port ? Number(port) : 6379,
    ...(username ? { username: decodeURIComponent(username) } : {}),
    ...(password ? { password: decodeURIComponent(password) } : {}),
    ...(pathname.length > 1 ? { db: Number(pathname.slice(1)) } : {}),
    ...(protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

main().catch((error: unknown) => {
  console.error(`[cleanup-e2e] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
