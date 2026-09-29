import type { Redis } from 'ioredis';
import type { PrismaClient } from '@loons/db';
import type { Actor } from '@loons/shared';
import type { AppConfig } from './config.ts';
import type { PrincipalStore } from './lib/actor.ts';
import type { BackgroundTasks } from './lib/background.ts';
import type { EmailProvider } from './lib/email/index.ts';
import type { AppQueues } from './lib/queues.ts';
import type { Storage } from './lib/storage.ts';
import type { AccessTokenVerifier } from './lib/tokens.ts';
import type { Realtime } from './realtime/socket.ts';
import type { Services } from './services/index.ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    redis: Redis;
    queues: AppQueues;
    tokens: AccessTokenVerifier;
    principals: PrincipalStore;
    background: BackgroundTasks;
    /** Attachment object storage (S3 / MinIO). */
    storage: Storage;
    services: Services;
    realtime: Realtime;
    /** Only set when the caller passed one (the API itself queues emails for the worker). */
    emailProvider: EmailProvider | null;
  }

  interface FastifyRequest {
    /** Set by `requireAuth` for Bearer-authenticated routes. */
    actor: Actor | null;
    /** True once the request proved the internal API key (/internal/*). */
    internalCaller: boolean;
  }
}

export {};
