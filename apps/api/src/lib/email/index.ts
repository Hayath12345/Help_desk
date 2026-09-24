import type { AppConfig } from '../../config.ts';
import type { EmailProvider } from './provider.ts';
import { createSesEmailProvider } from './ses.ts';
import { createSmtpEmailProvider } from './smtp.ts';

export type { EmailProvider, OutgoingEmail } from './provider.ts';

/** EMAIL_PROVIDER=smtp (default, Mailpit locally) | ses (AWS). */
export function createEmailProvider(config: Pick<AppConfig, 'email'>): EmailProvider {
  return config.email.provider === 'ses'
    ? createSesEmailProvider(config)
    : createSmtpEmailProvider(config);
}
