import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.ts';

export interface CreatePrismaClientOptions {
  /** Defaults to process.env.DATABASE_URL. */
  url?: string;
  /** Max pool connections per process (default 10). */
  poolSize?: number;
  log?: boolean;
}

export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const adapter = new PrismaPg({ connectionString: url, max: options.poolSize ?? 10 });
  return new PrismaClient({
    adapter,
    log: options.log ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
}

const globalForPrisma = globalThis as unknown as { __loonsPrisma?: PrismaClient };

/**
 * Process-wide client, created on first use (so importing this module never requires
 * DATABASE_URL) and reused across hot reloads in development.
 */
export function getPrisma(): PrismaClient {
  globalForPrisma.__loonsPrisma ??= createPrismaClient();
  return globalForPrisma.__loonsPrisma;
}
