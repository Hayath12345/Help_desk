import { randomUUID } from 'node:crypto';
import type { AppLogger as Logger } from '../logger.ts';
import { maskPhone, redactPii } from '../pii.ts';
import type { SmsProvider } from './provider.ts';

/** Development SMS "transport": logs one redacted line instead of sending. */
export function createConsoleSmsProvider(logger: Logger): SmsProvider {
  return {
    name: 'console',
    async send(message) {
      const messageId = `console-${randomUUID()}`;
      logger.info(
        {
          sms: {
            to: maskPhone(message.to),
            length: message.body.length,
            preview: redactPii(message.body).slice(0, 160),
          },
          messageId,
        },
        'sms (console provider, not sent)',
      );
      return { messageId };
    },
    async close() {},
  };
}
