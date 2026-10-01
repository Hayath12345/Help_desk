import { UnrecoverableError, type Job } from 'bullmq';
import type { EmailProvider } from '../lib/email/index.ts';
import type { AppLogger } from '../lib/logger.ts';
import { emailJobSchema, type EmailJobData, type EmailJobResult } from '../lib/queues.ts';

/**
 * SES errors that no retry can fix: the message is refused (an unverified or sandboxed identity or
 * recipient, a suspended identity), the sending domain is not verified, or the request itself is
 * invalid. They fail the job at once instead of five times over two and a half minutes.
 * (Throttling, 5xx and network errors are not listed: those are retried by the SDK and by BullMQ.)
 */
export const PERMANENT_SEND_ERRORS: ReadonlySet<string> = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'BadRequestException',
]);

/** `email` queue: validates the payload and hands it to the EmailProvider (SMTP / SES). */
export function createEmailProcessor(provider: EmailProvider, logger: AppLogger) {
  return async function processEmail(
    job: Job<EmailJobData, EmailJobResult>,
  ): Promise<EmailJobResult> {
    const parsed = emailJobSchema.safeParse(job.data);
    // A malformed payload will never succeed: fail without retries.
    if (!parsed.success) throw new UnrecoverableError('invalid email job payload');

    const { to, subject, html, text, headers, tag } = parsed.data;
    let result: EmailJobResult;
    try {
      result = await provider.send({
        to,
        subject,
        html,
        text,
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      if (err instanceof Error && PERMANENT_SEND_ERRORS.has(err.name)) {
        logger.warn(
          { queue: job.queueName, jobId: job.id, tag, provider: provider.name, error: err.name },
          'email refused by the provider; not retrying',
        );
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
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
