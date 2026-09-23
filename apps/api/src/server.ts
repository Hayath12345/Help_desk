// API entry point: `pnpm dev` / `pnpm start` (env loaded from the repo-root .env).
import { createPrismaClient } from '@loons/db';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './lib/logger.ts';
import { createQueues } from './lib/queues.ts';
import { closeRedis, createRedisClient } from './lib/redis.ts';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const bootLog = createLogger(config, 'api');
  const prisma = createPrismaClient({ url: config.databaseUrl, poolSize: config.databasePoolSize });
  const redis = createRedisClient(config.redisUrl, bootLog, 'api');
  const queues = createQueues({ connection: redis });
  const app = await buildApp({ config, prisma, redis, queues });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close(); // preClose closes Socket.IO, then HTTP; onClose drains background work
      await queues.close();
      await closeRedis(redis);
      await prisma.$disconnect();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.fatal({ err }, 'could not start the API server');
    await Promise.allSettled([queues.close(), closeRedis(redis), prisma.$disconnect()]);
    process.exit(1);
  }
}

void main();
