import { describe, expect, it } from 'vitest';
import { palette } from '@loons/ui';
import { DEFAULT_EMAIL_TEMPLATES, defaultCtaLabel, pickTemplateText } from './defaults.ts';
import { LINK_VARIABLES, renderTemplateEmail } from './render.tsx';

const reset = DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET;
const vars = {
  name: 'Ada',
  resetUrl: 'https://help.example.com/reset-password?token=abc123',
  expiresMinutes: 30,
};

describe('renderTemplateEmail', () => {
  it('renders an English email left-to-right with subject, body, CTA and text part', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: reset.subjectEn,
      body: reset.bodyEn,
      variables: vars,
      cta: { label: 'Reset password', url: '{{resetUrl}}' },
    });
    expect(out.subject).toBe('Reset your Loons Help Desk password');
    expect(out.html).toMatch(/<html[^>]*lang="en"/);
    expect(out.html).toMatch(/<html[^>]*dir="ltr"/);
    expect(out.html).toContain('Hi Ada,');
    expect(out.html).toContain('href="https://help.example.com/reset-password?token=abc123"');
    expect(out.html).toContain('Loons Help Desk');
    // Brand colours come from @loons/ui tokens.
    expect(out.html.toLowerCase()).toContain(palette.primary.toLowerCase());
    expect(out.text).toContain('Hi Ada,');
    expect(out.text).toContain('Reset password: https://help.example.com/reset-password?token=abc123');
    expect(out.text).not.toContain('<');
  });

  it('renders Arabic right-to-left with the Arabic font stack', async () => {
    const text = pickTemplateText(reset, 'ar');
    expect(text.locale).toBe('ar');
    const out = await renderTemplateEmail({
      locale: text.locale,
      subject: text.subject,
      body: text.body,
      variables: { ...vars, name: 'ليلى' },
      cta: { label: defaultCtaLabel('PASSWORD_RESET', 'ar') ?? '', url: vars.resetUrl },
    });
    expect(out.html).toMatch(/<html[^>]*dir="rtl"/);
    expect(out.html).toMatch(/<html[^>]*lang="ar"/);
    expect(out.html).toContain('IBM Plex Sans Arabic');
    expect(out.html).toContain('text-align:right');
    expect(out.html).toContain('مرحباً ليلى');
    expect(out.subject).toBe('إعادة تعيين كلمة المرور لحسابك في Loons Help Desk');
    expect(out.text).toContain('إعادة تعيين كلمة المرور: https://help.example.com/');
  });

  it('falls back to English when the Arabic text is empty', () => {
    const picked = pickTemplateText({ subjectEn: 'S', bodyEn: 'B', subjectAr: '  ', bodyAr: 'ب' }, 'ar');
    expect(picked).toEqual({ locale: 'en', subject: 'S', body: 'B' });
  });

  it('HTML-escapes variable values but keeps them verbatim in the text part', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 'Hello {{name}}',
      body: 'Name: {{name}}',
      variables: { name: '<script>alert(1)</script>' },
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.text).toContain('Name: <script>alert(1)</script>');
  });

  it('strips newlines from the subject (no header injection)', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 'Hi {{name}}',
      body: 'x',
      variables: { name: 'A\r\nBcc: evil@example.com' },
    });
    expect(out.subject).toBe('Hi A Bcc: evil@example.com');
    expect(out.subject).not.toMatch(/[\r\n]/);
  });

  it('drops a CTA whose URL is not http(s)', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'b',
      cta: { label: 'Click', url: 'javascript:alert(1)' },
    });
    expect(out.html).not.toContain('javascript:');
    expect(out.text).not.toContain('Click:');
  });

  it('keeps paragraphs and line breaks and links bare URLs', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Line one\nLine two\n\nSee https://example.com/help.',
    });
    expect(out.html).toMatch(/Line one(<!-- -->)?<br\/?>(<!-- -->)?Line two/);
    expect(out.html).toContain('href="https://example.com/help"');
    expect(out.text).toContain('Line one\nLine two\n\nSee https://example.com/help.');
  });
});

describe('renderTemplateEmail with a template that already contains the link', () => {
  it('keeps the button but skips the duplicate "copy this link" block', async () => {
    const url = 'https://help.example.com/reset-password?token=abc123';
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 'Reset',
      body: 'Use this link:\n\n{{resetUrl}}\n\nThanks',
      variables: { resetUrl: url },
      cta: { label: 'Reset password', url: '{{resetUrl}}' },
    });
    expect(out.html).toContain('Reset password');
    expect(out.html).not.toContain("If the button doesn't work");
    expect(out.html).not.toContain('If the button doesn&#x27;t work');
    expect(out.text.split(url)).toHaveLength(2); // the URL appears once in the text part
  });
});

describe('renderTemplateEmail links (only template text and app-generated URL variables)', () => {
  const evil = 'https://loons-support.evil.example/verify';

  it('never turns a URL inside a name into a link (password-reset phishing)', async () => {
    const text = pickTemplateText(reset, 'en');
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: text.subject,
      body: text.body,
      variables: { ...vars, name: `there. URGENT: verify at ${evil}` },
      cta: { label: 'Reset password', url: vars.resetUrl },
    });
    expect(out.html).not.toContain(`href="${evil}`);
    expect(out.html).toContain(`Hi there. URGENT: verify at ${evil},`); // still shown, as plain text
    expect(out.html).toContain(`href="${vars.resetUrl}"`); // the real link still works
  });

  it('links URLs written in the template itself and in link variables only', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: [
        'Help: https://help.example.com/faq',
        'Reset: {{resetUrl}}',
        'Verify: {{verifyUrl}}',
        'Links: {{ticketUrl}} / {{portalUrl}} / {{consoleUrl}} / {{queueUrl}} / {{ackUrl}}',
        'From: {{requesterName}}: {{description}}',
      ].join('\n'),
      variables: {
        resetUrl: 'https://help.example.com/r',
        verifyUrl: 'https://help.example.com/v',
        ticketUrl: 'https://help.example.com/t',
        portalUrl: 'https://help.example.com/p',
        consoleUrl: 'https://help.example.com/c',
        queueUrl: 'https://help.example.com/q',
        ackUrl: 'https://help.example.com/a',
        requesterName: 'https://attacker.example/name',
        description: 'see http://attacker.example/desc',
      },
    });
    for (const path of ['faq', 'r', 'v', 't', 'p', 'c', 'q', 'a']) {
      expect(out.html, path).toContain(`href="https://help.example.com/${path}"`);
    }
    expect(out.html).not.toContain('href="https://attacker.example');
    expect(out.html).not.toContain('href="http://attacker.example');
    expect(out.html).toContain('https://attacker.example/name');
    expect(LINK_VARIABLES).toEqual([
      'resetUrl',
      'verifyUrl',
      'signInUrl',
      'portalUrl',
      'ticketUrl',
      'ackUrl',
      'consoleUrl',
      'queueUrl',
    ]);
  });

  it('keeps substituted values on one line: they cannot add lines or paragraphs', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: 'Hi {{name}},\n\nBody text.',
      variables: { name: 'Ada\n\nYour account is locked.\r\nCall us' },
    });
    expect(out.html).toContain('Hi <!-- -->Ada Your account is locked. Call us<!-- -->,');
    expect(out.html).not.toMatch(/Ada(<!-- -->)?<br/);
    expect(out.text).toContain('Hi Ada Your account is locked. Call us,\n\nBody text.');
  });

  it('template line breaks and paragraphs still work around empty values', async () => {
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: 's',
      body: '  Line {{a}}\nnext {{missing}}  \n   \n\n  Second {{b}}.  ',
      variables: { a: 'one', b: 'two' },
    });
    expect(out.text.split('\n\n').slice(1, 3)).toEqual(['Line one\nnext', 'Second two.']);
    expect(out.html).toMatch(/Line (<!-- -->)?one(<!-- -->)?<br\/?>(<!-- -->)?next/);
  });
});

describe('EMAIL_VERIFICATION default template', () => {
  const verify = DEFAULT_EMAIL_TEMPLATES.EMAIL_VERIFICATION;
  const verifyUrl = 'https://help.example.com/verify-email/confirm?token=abc123';

  it('declares its variables and renders English with the confirm button', async () => {
    expect(verify.variables).toEqual(['name', 'verifyUrl', 'expiresHours']);
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: verify.subjectEn,
      body: verify.bodyEn,
      variables: { name: 'Ada', verifyUrl, expiresHours: 24 },
      cta: { label: defaultCtaLabel('EMAIL_VERIFICATION', 'en') ?? '', url: '{{verifyUrl}}' },
    });
    expect(out.subject).toBe('Confirm your email address for Loons Help Desk');
    expect(out.text).toContain('Hi Ada,');
    expect(out.text).toContain('24 hours');
    expect(out.html).toContain(`href="${verifyUrl}"`);
    expect(out.text).toContain(`Confirm email address: ${verifyUrl}`);
  });

  it('renders Arabic right-to-left', async () => {
    const text = pickTemplateText(verify, 'ar');
    const out = await renderTemplateEmail({
      locale: text.locale,
      subject: text.subject,
      body: text.body,
      variables: { name: 'ليلى', verifyUrl, expiresHours: 24 },
      cta: { label: defaultCtaLabel('EMAIL_VERIFICATION', 'ar') ?? '', url: verifyUrl },
    });
    expect(out.html).toMatch(/<html[^>]*dir="rtl"/);
    expect(out.text).toContain('مرحباً ليلى');
    expect(out.text).toContain(`تأكيد البريد الإلكتروني: ${verifyUrl}`);
  });
});

describe('GOOGLE_LINKED default template', () => {
  const linked = DEFAULT_EMAIL_TEMPLATES.GOOGLE_LINKED;
  const signInUrl = 'https://help.example.com/login';

  it('declares its variables and tells the owner the password was removed (EN)', async () => {
    expect(linked.variables).toEqual(['name', 'signInUrl']);
    const out = await renderTemplateEmail({
      locale: 'en',
      subject: linked.subjectEn,
      body: linked.bodyEn,
      variables: { name: 'Ada', signInUrl },
      cta: { label: defaultCtaLabel('GOOGLE_LINKED', 'en') ?? '', url: signInUrl },
    });
    expect(out.subject).toBe('Google sign-in was added to your Loons Help Desk account');
    expect(out.text).toContain('Hi Ada,');
    expect(out.text).toContain('we removed its password and signed out all other sessions');
    expect(out.html).toContain(`href="${signInUrl}"`);
    expect(out.text).toContain(`Sign in: ${signInUrl}`);
  });

  it('renders Arabic right-to-left with the Arabic product name', async () => {
    const text = pickTemplateText(linked, 'ar');
    expect(text.locale).toBe('ar');
    const out = await renderTemplateEmail({
      locale: text.locale,
      subject: text.subject,
      body: text.body,
      variables: { name: 'ليلى', signInUrl },
      cta: { label: defaultCtaLabel('GOOGLE_LINKED', 'ar') ?? '', url: signInUrl },
    });
    expect(out.html).toMatch(/<html[^>]*dir="rtl"/);
    expect(out.subject).toContain('مكتب دعم لونز');
    expect(out.text).toContain('مرحباً ليلى');
    expect(out.text).toContain(`تسجيل الدخول: ${signInUrl}`);
  });
});
