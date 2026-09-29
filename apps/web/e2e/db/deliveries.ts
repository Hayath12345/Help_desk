// Test tooling for notifications.spec.ts (not application code): prints the NotificationDelivery
// rows (the email / Teams / SMS log, Phase 3) of one ticket as a JSON line. The web app never
// touches the database, so — like the global teardown — this runs through the db package, under
// tsx inside packages/db where @loons/db's own dependencies resolve:
//   pnpm --filter @loons/db exec dotenv -e ../../.env -- tsx <this file> <ticket number>
// Read-only. The import path is computed on purpose: the web app's tsc must not compile the db
// package (its generated client and its own tsconfig).

/** Prefix of the JSON line (pnpm or dotenv may print other lines). */
export const DELIVERIES_MARKER = '@@deliveries@@';

export interface DeliveryRow {
  channel: 'EMAIL' | 'TEAMS' | 'SMS';
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  templateKey: string;
  recipientMasked: string;
}

interface TicketDeliveries {
  deliveries: DeliveryRow[];
}

interface DbClient {
  ticket: { findUnique(args: unknown): Promise<TicketDeliveries | null> };
  $disconnect(): Promise<void>;
}

async function main(): Promise<void> {
  const number = Number(process.argv[2]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('usage: deliveries.ts <ticket number>');
  }
  const entry = new URL('../../../../packages/db/src/index.ts', import.meta.url).href;
  const { createPrismaClient } = (await import(entry)) as {
    createPrismaClient: (options?: { poolSize?: number }) => DbClient;
  };
  const db = createPrismaClient({ poolSize: 1 });
  try {
    const ticket = await db.ticket.findUnique({
      where: { number },
      select: {
        deliveries: {
          select: { channel: true, status: true, templateKey: true, recipientMasked: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    process.stdout.write(`${DELIVERIES_MARKER}${JSON.stringify(ticket?.deliveries ?? [])}\n`);
  } finally {
    await db.$disconnect();
  }
}

// Only when run as a script (the spec imports the marker and the row type from here).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  main().catch((error: unknown) => {
    console.error(`[deliveries] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
