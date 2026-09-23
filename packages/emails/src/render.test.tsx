import { describe, expect, it } from 'vitest';
import { palette } from '@loons/ui';
import { DEFAULT_EMAIL_TEMPLATES, defaultCtaLabel, pickTemplateText } from './defaults.ts';
import { renderTemplateEmail } from './render.tsx';

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
