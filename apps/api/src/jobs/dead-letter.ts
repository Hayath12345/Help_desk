import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppLogger } from '../lib/logger.ts';
import { redactPii } from '../lib/pii.ts';
import { DEAD_LETTER_LIST, DEAD_LETTER_MAX } from '../lib/queues.ts';

export interface DeadLetterRecord {
  queue: string;
  jobId: string;
  name: string;
  attempts: number;
  error: string;
  failedAt: string;
}

/** True when BullMQ will not retry this job again (attempts exhausted or unrecoverable). */
export function isFinalFailure(job: Job): boolean {
  return typeof job.finishedOn === 'number' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Records a job that failed for good: one structured log line and an entry in the capped
 * `<prefix>:dead-letter` Redis list. No job data (it may hold personal data); the error
 * message is scrubbed of emails and phone numbers.
 */
export async function recordDeadLetter(
  deps: { redis: Redis; prefix: string; logger: AppLogger },
  job: Job,
  error: Error,
): Promise<DeadLetterRecord> {
  const record: DeadLetterRecord = {
    queue: job.queueName,
    jobId: String(job.id ?? ''),
    name: job.name,
    attempts: job.attemptsMade,
    error: redactPii(error.message).slice(0, 500),
    failedAt: new Date().toISOString(),
  };
  deps.logger.error({ deadLetter: record }, 'job moved to dead letter');
  const key = `${deps.prefix}:${DEAD_LETTER_LIST}`;
  try {
    await deps.redis.multi().lpush(key, JSON.stringify(record)).ltrim(key, 0, DEAD_LETTER_MAX - 1).exec();
  } catch (err) {
    deps.logger.error({ err }, 'could not store dead-letter record');
  }
  return record;
}
