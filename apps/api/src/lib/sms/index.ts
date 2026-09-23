import type { AppLogger as Logger } from '../logger.ts';
import type { AppConfig } from '../../config.ts';
import { createConsoleSmsProvider } from './console.ts';
import type { SmsProvider } from './provider.ts';
import { createSnsSmsProvider } from './sns.ts';

export type { OutgoingSms, SmsProvider } from './provider.ts';

/** SMS_PROVIDER=console (default, logs a redacted line) | sns (AWS). */
export function createSmsProvider(config: Pick<AppConfig, 'sms'>, logger: Logger): SmsProvider {
  return config.sms.provider === 'sns' ? createSnsSmsProvider(config) : createConsoleSmsProvider(logger);
}
