// Worker entry point: `pnpm dev:worker` / `pnpm start:worker`. Consumes the BullMQ queues
// (email, notifications, escalation, sla) in a separate process from the HTTP API and, unless
// WORKER_SCHEDULERS=false, registers the repeatable SLA jobs.
import { createPrismaClient } from '@loons/db';
import { ConfigError, loadConfig } from './config.ts';
import { digestTime } from './jobs/maintenance.ts';
import { registerSchedulers } from './jobs/schedulers.ts';
import { startWorkers } from './jobs/workers.ts';
import { createEmailProvider } from './lib/email/index.ts';
import { createLogger } from './lib/logger.ts';
import { createQueues, queuePrefixFor } from './lib/queues.ts';
import { closeRedis, createBullConnection, createRedisClient } from './lib/redis.ts';
import { createSmsProvider } from './lib/sms/index.ts';
import { createStorage } from './lib/storage.ts';
import { createTeamsProvider } from './lib/teams/index.ts';
import { createTicketConfigService } from './services/ticket-config.service.ts';

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
  const prisma = createPrismaClient({ url: config.databaseUrl, poolSize: config.databasePoolSize });
  const redis = createRedisClient(config.redisUrl, logger, 'worker');
  const prefix = queuePrefixFor(config);
  const queues = createQueues({ connection: redis, prefix });
  const emailProvider = createEmailProvider(config);
  const smsProvider = createSmsProvider(config, logger);
  const teamsProvider = createTeamsProvider(config, logger);
  const ticketConfig = createTicketConfigService({
    prisma,
    redis,
    prefix: config.redisPrefix,
    logger: logger.child({ svc: 'ticket-config' }),
  });
  const workers = startWorkers({
    createConnection: (name) => createBullConnection(config.redisUrl, logger, name),
    redis,
    emailProvider,
    logger,
    prefix,
    prisma,
    smsProvider,
    teamsProvider,
    queues,
    ticketConfig,
    config,
    storage: createStorage(config.s3),
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
    await queues.close();
    await Promise.allSettled([emailProvider.close(), smsProvider.close()]);
    await closeRedis(redis);
    await prisma.$disconnect();
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
  let schedulers: string[] = [];
  if (config.worker.schedulers) {
    try {
      const calendar = await ticketConfig.getCalendar();
      schedulers = await registerSchedulers(queues.sla, {
        timeZone: calendar.timeZone,
        digestTime: await digestTime(workers.context),
      });
    } catch (err) {
      logger.error({ err }, 'could not register the SLA schedulers (jobs are still consumed)');
    }
  }
  logger.info(
    {
      queues: workers.workers.map((w) => w.name),
      schedulers,
      emailProvider: emailProvider.name,
      smsProvider: smsProvider.name,
      teamsProvider: teamsProvider.name,
      env: config.env,
    },
    'worker ready',
  );
}

void main();
