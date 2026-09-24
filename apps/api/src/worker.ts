// Worker entry point: `pnpm dev:worker` / `pnpm start:worker`. Consumes the BullMQ queues
// (email, notifications, sla) in a separate process from the HTTP API.
import { ConfigError, loadConfig } from './config.ts';
import { startWorkers } from './jobs/workers.ts';
import { createEmailProvider } from './lib/email/index.ts';
import { createLogger } from './lib/logger.ts';
import { closeRedis, createBullConnection, createRedisClient } from './lib/redis.ts';

const SHUTDOWN_TIMEOUT_MS = 30_000;

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

  const logger = createLogger(config, 'worker');
  const redis = createRedisClient(config.redisUrl, logger, 'worker');
  const emailProvider = createEmailProvider(config);
  const workers = startWorkers({
    createConnection: (name) => createBullConnection(config.redisUrl, logger, name),
    redis,
    emailProvider,
    logger,
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down (finishing active jobs)');
    const force = setTimeout(() => {
      logger.error('worker shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await workers.close();
    await emailProvider.close();
    await closeRedis(redis);
    clearTimeout(force);
    logger.info('worker stopped');
    process.exit(0);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });

  // Surface a misconfigured / unreachable SMTP server at boot (jobs still retry with backoff).
  emailProvider
    .verify?.()
    .then(() => logger.info({ emailProvider: emailProvider.name }, 'email transport reachable'))
    .catch((err: unknown) =>
      logger.warn({ err }, 'email transport not reachable; email jobs will retry'),
    );

  await workers.ready();
  logger.info(
    {
      queues: workers.workers.map((w) => w.name),
      emailProvider: emailProvider.name,
      env: config.env,
    },
    'worker ready',
  );
}

void main();
