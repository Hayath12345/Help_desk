import type { Job } from 'bullmq';
import type { AppLogger } from '../lib/logger.ts';

/**
 * `notifications` (Phase 3: ticket emails, Teams webhooks, SMS, in-app) and `sla`
 * (Phase 3: repeatable SLA sweep, P1 escalation) have no work yet. The processors are
 * registered so the queues are consumed and the wiring is exercised end to end.
 */
export function createPlaceholderProcessor(logger: AppLogger) {
  return async function processPlaceholder(job: Job): Promise<{ skipped: true }> {
    logger.debug(
      { queue: job.queueName, jobId: job.id, name: job.name },
      'job received (no processor yet)',
    );
    return { skipped: true };
  };
}
