/** One outgoing email (already rendered). */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

/** Transport-agnostic email sender: SMTP (Mailpit locally) or AWS SES, chosen by EMAIL_PROVIDER. */
export interface EmailProvider {
  readonly name: 'smtp' | 'ses';
  send(message: OutgoingEmail): Promise<{ messageId: string }>;
  /** Verifies connectivity where the transport supports it (SMTP). */
  verify?(): Promise<void>;
  close(): Promise<void>;
}
