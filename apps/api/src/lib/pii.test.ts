import { describe, expect, it } from 'vitest';
import { maskPhone, redactPii, urlHost } from './pii.ts';

describe('redactPii', () => {
  it('removes email addresses and phone numbers', () => {
    expect(redactPii('550 <jane.doe+x@qnb.com.qa> rejected; call +974 5550 1234')).toBe(
      '550 <[email]> rejected; call [phone]',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(redactPii('Connection timeout after 10000 ms (LG-4817)')).toBe(
      'Connection timeout after 10000 ms (LG-4817)',
    );
  });
});

describe('redactPii: URLs and international prefixes (Phase 3)', () => {
  it('keeps only the scheme and host of URLs (webhook secrets live in the path / query)', () => {
    expect(
      redactPii(
        'POST https://tenant.webhook.office.com/webhookb2/abc/IncomingWebhook/SECRET failed',
      ),
    ).toBe('POST https://tenant.webhook.office.com/[redacted] failed');
    expect(redactPii('see https://prod-12.logic.azure.com:443/workflows/x?sig=SECRET&sv=1')).toBe(
      'see https://prod-12.logic.azure.com:443/[redacted]',
    );
    expect(redactPii('host http://localhost:3000 is up')).toBe('host http://localhost:3000 is up');
  });

  it('also redacts numbers written with the 00 international prefix', () => {
    expect(redactPii('SMS to 00974 5550 1234 failed')).toBe('SMS to [phone] failed');
    expect(redactPii('order 1000 items')).toBe('order 1000 items');
  });
});

describe('urlHost', () => {
  it('returns the host of a URL, never its path', () => {
    expect(urlHost('https://Tenant.Webhook.Office.com/webhookb2/SECRET')).toBe(
      'tenant.webhook.office.com',
    );
    expect(urlHost('nope')).toBe('invalid-url');
  });
});

describe('maskPhone', () => {
  it('keeps the country prefix and the last two digits', () => {
    expect(maskPhone('+97455501234')).toBe('+974******34');
    expect(maskPhone('123')).toBe('***');
  });
});
