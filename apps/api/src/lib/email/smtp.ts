import { createTransport } from 'nodemailer';
import type { AppConfig } from '../../config.ts';
import type { EmailProvider } from './provider.ts';

/** SMTP via nodemailer (pooled). Locally this is Mailpit on :1025 (no TLS, no auth). */
export function createSmtpEmailProvider(config: Pick<AppConfig, 'email'>): EmailProvider {
  const { smtp, from } = config.email;
  const transport = createTransport({
    pool: true,
    maxConnections: 5,
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? '' } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  return {
    name: 'smtp',
    async send(message) {
      const info = await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.headers ? { headers: message.headers } : {}),
      });
      return { messageId: info.messageId };
    },
    async verify() {
      await transport.verify();
    },
    async close() {
      transport.close();
    },
  };
}
