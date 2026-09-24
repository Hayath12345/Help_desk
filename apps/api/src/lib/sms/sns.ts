import { PublishCommand, SNSClient, type MessageAttributeValue } from '@aws-sdk/client-sns';
import type { AppConfig } from '../../config.ts';
import type { SmsProvider } from './provider.ts';

/** AWS SNS direct-to-phone SMS (transactional). Credentials from the default provider chain. */
export function createSnsSmsProvider(config: Pick<AppConfig, 'sms'>): SmsProvider {
  const client = new SNSClient({ region: config.sms.snsRegion });
  const attributes: Record<string, MessageAttributeValue> = {
    'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
  };
  if (config.sms.senderId) {
    attributes['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: config.sms.senderId };
  }

  return {
    name: 'sns',
    async send(message) {
      const result = await client.send(
        new PublishCommand({
          PhoneNumber: message.to,
          Message: message.body,
          MessageAttributes: attributes,
        }),
      );
      return { messageId: result.MessageId ?? '' };
    },
    async close() {
      client.destroy();
    },
  };
}
