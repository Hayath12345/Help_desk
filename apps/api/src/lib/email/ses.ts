import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { AppConfig } from '../../config.ts';
import type { EmailProvider } from './provider.ts';

/**
 * AWS SES (v2 API). Credentials come from the default provider chain (task / instance role).
 * EMAIL_FROM must be a verified identity in SES_REGION.
 */
export function createSesEmailProvider(config: Pick<AppConfig, 'email'>): EmailProvider {
  const client = new SESv2Client({ region: config.email.sesRegion });
  const from = config.email.from;

  return {
    name: 'ses',
    async send(message) {
      const headers = Object.entries(message.headers ?? {}).map(([Name, Value]) => ({
        Name,
        Value,
      }));
      const result = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: message.html, Charset: 'UTF-8' },
                Text: { Data: message.text, Charset: 'UTF-8' },
              },
              ...(headers.length > 0 ? { Headers: headers } : {}),
            },
          },
        }),
      );
      return { messageId: result.MessageId ?? '' };
    },
    async close() {
      client.destroy();
    },
  };
}
