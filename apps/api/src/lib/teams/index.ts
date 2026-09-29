import type { AppConfig } from '../../config.ts';
import type { AppLogger as Logger } from '../logger.ts';
import { createConsoleTeamsProvider } from './console.ts';
import type { TeamsProvider } from './provider.ts';
import { createWebhookTeamsProvider } from './webhook.ts';

export {
  TeamsPermanentError,
  type OutgoingTeamsPost,
  type TeamsPostResult,
  type TeamsProvider,
} from './provider.ts';
export { hostAllowed, webhookUrlProblem } from './webhook.ts';

/** TEAMS_PROVIDER=console (default, logs a redacted line) | webhook (HTTPS POST). */
export function createTeamsProvider(
  config: Pick<AppConfig, 'teams'>,
  logger: Logger,
): TeamsProvider {
  return config.teams.provider === 'webhook'
    ? createWebhookTeamsProvider(config)
    : createConsoleTeamsProvider(logger);
}
