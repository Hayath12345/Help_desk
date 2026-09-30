import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import type { AppConfig } from '../../config.ts';
import type { PrincipalStore } from '../../lib/actor.ts';
import type { AppLogger as Logger } from '../../lib/logger.ts';
import type { AppQueues } from '../../lib/queues.ts';
import type { Notifier } from '../notifier.ts';
import type { SessionsService } from '../sessions.service.ts';
import type { TicketConfigService } from '../ticket-config.service.ts';
import type { ConfigChanges } from './config-changes.ts';
import type { AdminWriter } from './write.ts';

/** What every admin section service is built with (`create<Section>AdminService(deps)`). */
export interface AdminDeps {
  prisma: PrismaClient;
  redis: Redis;
  queues: AppQueues;
  config: AppConfig;
  logger: Logger;
  ticketConfig: TicketConfigService;
  /** Principal cache; `invalidate` also re-checks the user's sockets (app.ts). */
  principals: PrincipalStore;
  sessions: SessionsService;
  notifier: Notifier;
  /** Runs a write in one transaction with its audit rows, then the after-commit effects. */
  writer: AdminWriter;
  /** Config version bump + `config:updated` broadcast (the writer calls it after commit). */
  configChanges: ConfigChanges;
}
