import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../lib/email/index.ts';
import type { AppLogger } from '../lib/logger.ts';
import type { EmailJobData, EmailJobResult } from '../lib/queues.ts';
import { createEmailProcessor } from './email.ts';

const data: EmailJobData = {
  to: 'client@example.com',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  tag: 'test',
};
const job = (payload: unknown = data) =>
  ({ id: '1', queueName: 'email', data: payload }) as unknown as Job<EmailJobData, EmailJobResult>;
const logger = () => ({ info: vi.fn(), warn: vi.fn() }) as unknown as AppLogger;
function failing(name: string, message = 'boom'): EmailProvider {
  const err = Object.assign(new Error(message), { name });
  return { name: 'ses', send: vi.fn().mockRejectedValue(err), close: vi.fn() };
}

describe('email job', () => {
  it('sends and returns the message id', async () => {
    const provider: EmailProvider = {
      name: 'smtp',
      send: vi.fn().mockResolvedValue({ messageId: 'm-1' }),
      close: vi.fn(),
    };
    await expect(createEmailProcessor(provider, logger())(job())).resolves.toEqual({
      messageId: 'm-1',
    });
  });

  it('a malformed payload is unrecoverable', async () => {
    const provider = failing('x');
    await expect(createEmailProcessor(provider, logger())(job({ to: 'nope' }))).rejects.toThrow(
      UnrecoverableError,
    );
    expect(provider.send).not.toHaveBeenCalled();
  });

  it.each(['MessageRejected', 'MailFromDomainNotVerifiedException', 'BadRequestException'])(
    'SES %s is permanent: the job fails at once, with the provider message and without a retry',
    async (name) => {
      const log = logger();
      const run = createEmailProcessor(failing(name, 'Email address is not verified.'), log)(job());
      await expect(run).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(run).rejects.toThrow('Email address is not verified.');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: name, tag: 'test' }),
        'email refused by the provider; not retrying',
      );
    },
  );

  it.each(['ThrottlingException', 'ServiceUnavailableException', 'TimeoutError', 'Error'])(
    'a transient %s is rethrown unchanged so BullMQ retries it',
    async (name) => {
      const run = createEmailProcessor(failing(name), logger())(job());
      await expect(run).rejects.toThrow('boom');
      await expect(run).rejects.not.toBeInstanceOf(UnrecoverableError);
    },
  );
});
