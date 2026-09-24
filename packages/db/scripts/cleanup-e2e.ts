// Deletes the accounts the Playwright suite created (and the rows that depend on them), so repeated
// `pnpm test:e2e` runs don't pile up clients in the seeded organisations. Run by the Playwright
// global teardown: `pnpm --filter @loons/db db:cleanup-e2e`. Local / CI databases only.
import { createPrismaClient } from '../src/index.ts';
import { e2eUserWhere } from './e2e-users.ts';

async function main(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'production') throw new Error('refusing to run with NODE_ENV=production');

  const db = createPrismaClient({ poolSize: 2 });
  try {
    const deleted = await db.$transaction(async (tx) => {
      const users = await tx.user.findMany({ where: e2eUserWhere(), select: { id: true } });
      const ids = users.map((u) => u.id);
      if (ids.length === 0) return { users: 0, tickets: 0 };
      // Rows that would block the delete (onDelete: Restrict). Ticket children cascade; accounts,
      // tokens, memberships and notifications cascade from the user.
      await tx.attachment.deleteMany({ where: { uploaderId: { in: ids } } });
      const tickets = await tx.ticket.deleteMany({ where: { requesterId: { in: ids } } });
      const removed = await tx.user.deleteMany({ where: { id: { in: ids } } });
      return { users: removed.count, tickets: tickets.count };
    });
    process.stdout.write(`[cleanup-e2e] removed ${deleted.users} e2e user(s) and ${deleted.tickets} ticket(s)\n`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[cleanup-e2e] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
