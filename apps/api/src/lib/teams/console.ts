import { randomUUID } from 'node:crypto';
import type { AppLogger as Logger } from '../logger.ts';
import { urlHost } from '../pii.ts';
import type { TeamsProvider } from './provider.ts';

/**
 * Development Teams "transport": logs one line (card title, size, the webhook's host — never
 * the URL) instead of posting, and reports it sent, so the delivery log shows the Teams post.
 */
export function createConsoleTeamsProvider(logger: Logger): TeamsProvider {
  return {
    name: 'console',
    describe: () => 'console',
    async post({ webhookUrl, message }) {
      const messageId = `console-${randomUUID()}`;
      const card = message.attachments[0].content;
      const title = card.body[0]?.type === 'TextBlock' ? card.body[0].text : '';
      logger.info(
        {
          teams: {
            title: title.slice(0, 120),
            bytes: Buffer.byteLength(JSON.stringify(message)),
            webhookHost: webhookUrl ? urlHost(webhookUrl) : null,
          },
          messageId,
        },
        'teams (console provider, not sent)',
      );
      return { status: 'sent', messageId };
    },
  };
}
