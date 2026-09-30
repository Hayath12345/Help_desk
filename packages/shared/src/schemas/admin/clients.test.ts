import { describe, expect, it } from 'vitest';
import { PUBLIC_EMAIL_DOMAINS, emailDomainSchema } from './clients.ts';

// E10: an organisation never claims a public mail domain (every sign-up from it would join the
// organisation). Regional variants of the big consumer providers count too (contract-2).

const message = (domain: string) => {
  const parsed = emailDomainSchema.safeParse(domain);
  return parsed.success ? null : parsed.error.issues[0]?.message;
};

describe('emailDomainSchema — public mail domains (E10)', () => {
  it.each([
    'gmail.com',
    'googlemail.com',
    'hotmail.co.uk',
    'hotmail.fr',
    'outlook.sa',
    'outlook.com.qa',
    'live.co.uk',
    'msn.com',
    'yahoo.co.uk',
    'yahoo.fr',
    'icloud.com',
    'me.com',
    'aol.co.uk',
    'protonmail.ch',
    'pm.me',
    'gmx.net',
    'gmx.de',
    'yandex.ru',
    'mail.ru',
    'web.de',
    'qq.com',
    '163.com',
    'HOTMAIL.CO.UK',
  ])('refuses %s', (domain) => {
    expect(message(domain)).toBe('validation.publicEmailDomain');
  });

  // Not on the exact list: a provider name under a public suffix is public too (contract-2).
  it.each([
    'aol.jp',
    'icloud.com.cn',
    'hotmail.com.tw',
    'yandex.uz',
    'gmail.co.za',
    'msn.co.jp',
    'ymail.co.uk',
    'proton.ch',
  ])('refuses the unlisted provider variant %s', (domain) => {
    expect(PUBLIC_EMAIL_DOMAINS).not.toContain(domain);
    expect(message(domain)).toBe('validation.publicEmailDomain');
  });

  it.each([
    'hamad.qa',
    'qnb.com',
    'moi.gov.qa',
    'mail.hamad.qa',
    'outlook-partners.com',
    'gmail.hamad.qa',
    'live-events.qa',
    'yahoo.hamad.com.qa',
  ])('accepts the company domain %s', (domain) => {
    expect(message(domain)).toBeNull();
  });

  it('is a static list of lower-case hostnames without duplicates', () => {
    for (const domain of PUBLIC_EMAIL_DOMAINS) expect(domain).toBe(domain.trim().toLowerCase());
    expect(new Set(PUBLIC_EMAIL_DOMAINS).size).toBe(PUBLIC_EMAIL_DOMAINS.length);
  });
});
