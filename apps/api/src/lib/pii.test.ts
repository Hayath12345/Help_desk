import { describe, expect, it } from 'vitest';
import { maskPhone, redactPii } from './pii.ts';

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

describe('maskPhone', () => {
  it('keeps the country prefix and the last two digits', () => {
    expect(maskPhone('+97455501234')).toBe('+974******34');
    expect(maskPhone('123')).toBe('***');
  });
});
