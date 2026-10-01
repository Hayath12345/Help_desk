/**
 * Socket timeouts for the AWS SDK clients that send email (SES) and SMS (SNS): a hung connection
 * must fail the job, which BullMQ then retries, instead of stalling the worker. (The SDK itself
 * has no timeout by default.)
 */
export const AWS_REQUEST_HANDLER = { connectionTimeout: 5_000, requestTimeout: 15_000 } as const;
