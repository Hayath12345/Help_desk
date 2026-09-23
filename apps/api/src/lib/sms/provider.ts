export interface OutgoingSms {
  /** E.164, e.g. +97455501234. */
  to: string;
  body: string;
}

/** Transport-agnostic SMS sender: console logger locally, AWS SNS in production (SMS_PROVIDER). */
export interface SmsProvider {
  readonly name: 'console' | 'sns';
  send(message: OutgoingSms): Promise<{ messageId: string }>;
  close(): Promise<void>;
}
