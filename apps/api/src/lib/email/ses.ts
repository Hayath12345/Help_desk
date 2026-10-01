import { SendEmailCommand, SESv2Client, type SESv2ClientConfig } from '@aws-sdk/client-sesv2';
import type { AppConfig } from '../../config.ts';
import { AWS_REQUEST_HANDLER } from '../aws.ts';
import type { EmailProvider } from './provider.ts';

/**
 * AWS SES (v2 API). Credentials come from the default provider chain (task / instance role), never
 * from configuration. The region is SES_REGION; EMAIL_FROM must be a verified identity there.
 * `clientConfig` is a test seam (a fake request handler); the region always comes from the config.
 */
export function createSesEmailProvider(
  config: Pick<AppConfig, 'email'>,
  options: { clientConfig?: SESv2ClientConfig } = {},
): EmailProvider {
  const client = new SESv2Client({
    requestHandler: AWS_REQUEST_HANDLER,
    ...options.clientConfig,
    region: config.email.sesRegion,
  });
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
