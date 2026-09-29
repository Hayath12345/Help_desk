import type { TeamsMessage } from '@loons/emails';

/** One Teams channel post: the team's webhook URL (a secret) and the card. */
export interface OutgoingTeamsPost {
  /** `Team.teamsWebhookUrl`; null when the team has none. */
  webhookUrl: string | null;
  message: TeamsMessage;
}

export type TeamsPostResult =
  | { status: 'sent'; messageId: string }
  /** Nothing was posted and retrying won't change that (no webhook configured). */
  | { status: 'skipped'; reason: string };

/**
 * Transport-agnostic Teams sender (decision D12), chosen by TEAMS_PROVIDER: `console` logs one
 * redacted line (local development, E2E), `webhook` POSTs the card over HTTPS to an allow-listed
 * host. The webhook URL is never logged, stored in a delivery record or sent to a browser.
 */
export interface TeamsProvider {
  readonly name: 'console' | 'webhook';
  /** What a delivery records as its recipient: the webhook's host, or "console". */
  describe(webhookUrl: string | null): string;
  post(post: OutgoingTeamsPost): Promise<TeamsPostResult>;
}

/** A failure that retrying cannot fix (refused URL, 4xx other than 408 / 429). */
export class TeamsPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsPermanentError';
  }
}
