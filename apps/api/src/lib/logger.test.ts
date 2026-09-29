import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, loggerOptions } from './logger.ts';

// No PII or secrets in logs (spec §12, contract "Logging"): phone numbers and webhook URLs are
// redacted like emails and tokens, at the top level and one or two objects deep, and error
// messages are scrubbed of URL paths.

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const options = loggerOptions(
    { logLevel: 'info', isProduction: true, env: 'production' },
    'test',
  );
  return { logger: pino(options, stream), lines };
}

describe('logger redaction', () => {
  it('censors phone numbers and Teams webhook URLs wherever they are logged', () => {
    expect(REDACT_PATHS).toEqual(
      expect.arrayContaining(['phone', '*.phone', '*.*.phone', 'webhookUrl', '*.teamsWebhookUrl']),
    );
    const { logger, lines } = capture();
    logger.info(
      {
        phone: '+97455501234',
        user: { phone: '+97455501234', email: 'a@b.example' },
        team: { teamsWebhookUrl: 'https://x.webhook.office.com/webhookb2/SECRET' },
        delivery: { target: { webhookUrl: 'https://x.webhook.office.com/webhookb2/SECRET' } },
      },
      'sending',
    );
    const out = lines.join('\n');
    expect(out).not.toContain('55501234');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('a@b.example');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs URL paths, emails and phone numbers from logged errors', () => {
    const { logger, lines } = capture();
    logger.error(
      {
        err: new Error(
          'POST https://x.webhook.office.com/webhookb2/SECRET failed for ops@loonsgroup.com, +974 5550 1234',
        ),
      },
      'teams failed',
    );
    const out = lines.join('\n');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('ops@loonsgroup.com');
    expect(out).not.toContain('5550 1234');
    expect(out).toContain('https://x.webhook.office.com/[redacted]');
  });
});
