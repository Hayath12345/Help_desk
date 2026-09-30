import {
  CONFIG_SCOPES,
  SERVER_EVENTS,
  configUpdatedPayloadSchema,
  type ConfigScope,
} from '@loons/shared';
import type { AppLogger as Logger } from '../../lib/logger.ts';
import type { TicketConfigService } from '../ticket-config.service.ts';

// Live refresh after an admin change (decision E18). Once the change has COMMITTED:
// 1. the config generation is bumped and the cached form config + calendar dropped (every API
//    instance and the worker read the same Redis keys), then
// 2. `config:updated {scope, version}` goes to every socket (all instances via the Redis adapter).
// A browser that refetches and still sees an older `version` refetches again. Never throws: the
// change is saved either way; a failed bump is logged and announced with version 0 (clients then
// refetch once, and the caches expire on their own within 300 s / 60 s).

export interface ConfigChanges {
  /**
   * Bumps the config version and broadcasts `config:updated` once per scope. Call after the
   * transaction committed (the admin writer does). Returns the version announced.
   */
  afterConfigChange(scope: ConfigScope | readonly ConfigScope[]): Promise<number>;
}

/** Emits to every socket (Realtime.broadcast). */
export type Broadcast = (event: string, payload: unknown) => void;

const RETRY_DELAY_MS = 100;

export function createConfigChanges(deps: {
  ticketConfig: Pick<TicketConfigService, 'invalidate'>;
  broadcast: Broadcast;
  logger: Logger;
}): ConfigChanges {
  const { ticketConfig, broadcast, logger } = deps;

  return {
    async afterConfigChange(scope) {
      const scopes = [...new Set(typeof scope === 'string' ? [scope] : scope)].filter((s) =>
        (CONFIG_SCOPES as readonly string[]).includes(s),
      );
      let version = await ticketConfig.invalidate();
      if (version === null) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        version = await ticketConfig.invalidate();
      }
      if (version === null) {
        logger.error('config version could not be bumped; clients are told version 0');
        version = 0;
      }
      for (const s of scopes) {
        try {
          broadcast(
            SERVER_EVENTS.configUpdated,
            configUpdatedPayloadSchema.parse({ scope: s, version }),
          );
        } catch (err) {
          logger.error({ err, scope: s }, 'could not broadcast config:updated');
        }
      }
      return version;
    },
  };
}
