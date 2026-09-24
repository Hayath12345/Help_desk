import { UnrecoverableError, type Job } from 'bullmq';
import type { EmailProvider } from '../lib/email/index.ts';
import type { AppLogger } from '../lib/logger.ts';
import { emailJobSchema, type EmailJobData, type EmailJobResult } from '../lib/queues.ts';

/** `email` queue: validates the payload and hands it to the EmailProvider (SMTP / SES). */
export function createEmailProcessor(provider: EmailProvider, logger: AppLogger) {
  return async function processEmail(
    job: Job<EmailJobData, EmailJobResult>,
  ): Promise<EmailJobResult> {
    const parsed = emailJobSchema.safeParse(job.data);
    // A malformed payload will never succeed: fail without retries.
    if (!parsed.success) throw new UnrecoverableError('invalid email job payload');

    const { to, subject, html, text, headers, tag } = parsed.data;
    const result = await provider.send({
      to,
      subject,
      html,
      text,
      ...(headers ? { headers } : {}),
    });
    logger.info(
      {
        queue: job.queueName,
        jobId: job.id,
        tag,
        provider: provider.name,
        messageId: result.messageId,
      },
      'email sent',
    );
    return result;
  };
}
