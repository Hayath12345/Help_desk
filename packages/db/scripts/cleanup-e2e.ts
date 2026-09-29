// Deletes the accounts and tickets the Playwright suite created (and the rows that depend on
// them), so repeated `pnpm test:e2e` runs don't pile up clients or tickets in the seeded
// organisations — and the stored files of their attachments (review P2-CC-6). Run by the
// Playwright global teardown: `pnpm --filter @loons/db db:cleanup-e2e`.
// Development / test databases only.
import { S3Client } from '@aws-sdk/client-s3';
import { isNonProductionEnv } from '../prisma/seed-data/options.ts';
import { createPrismaClient, type Prisma } from '../src/index.ts';
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
      // Ticket children (messages, events, tags, attachment rows) cascade.
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
      `[cleanup-e2e] removed ${deleted.users} e2e user(s), ${deleted.tickets} ticket(s) and ${objects} stored file(s)\n`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[cleanup-e2e] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
