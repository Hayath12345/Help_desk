import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATE_KEYS } from './defaults.ts';
import {
  allowedTemplateVariables,
  legacyTemplateVariables,
  renderEmailTemplatePreview,
  sampleTemplateVariables,
  templateBlockVariables,
  templatePlaceholderProblems,
} from './preview.ts';

const APP = 'https://help.example.com';

describe('template placeholders (E14)', () => {
  it('allows exactly the variables declared in code', () => {
    expect(allowedTemplateVariables('PASSWORD_RESET')).toEqual([
      'name',
      'resetUrl',
      'expiresMinutes',
    ]);
    expect(templateBlockVariables('AGENT_REPLY_CLIENT')).toEqual(['messageBody']);
    expect(templateBlockVariables('P4_DAILY_DIGEST')).toEqual(['ticketList']);
    expect(templateBlockVariables('PASSWORD_RESET')).toEqual([]);
  });

  it('accepts the built-in text of every template', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const t = DEFAULT_EMAIL_TEMPLATES[key];
      expect(
        templatePlaceholderProblems(key, { subject: t.subjectEn, body: t.bodyEn }),
        key,
      ).toEqual([]);
      expect(
        templatePlaceholderProblems(key, { subject: t.subjectAr, body: t.bodyAr }),
        key,
      ).toEqual([]);
    }
  });

  it('refuses unknown placeholders (subject or body) and block variables in the subject', () => {
    expect(
      templatePlaceholderProblems('AGENT_REPLY_CLIENT', {
        subject: '{{ticketNumber}} {{messageBody}} {{ secret }}',
        body: 'Hi {{name}}, {{messageBody}} {{constructor}} {{secret}} {{secret}}',
      }),
    ).toEqual([
      { field: 'subject', name: 'messageBody', reason: 'block_in_subject' },
      { field: 'subject', name: 'secret', reason: 'unknown_variable' },
      { field: 'body', name: 'constructor', reason: 'unknown_variable' },
      { field: 'body', name: 'secret', reason: 'unknown_variable' },
    ]);
    // A variable of another template is unknown here.
    expect(
      templatePlaceholderProblems('PASSWORD_RESET', { subject: '', body: '{{ticketNumber}}' }),
    ).toEqual([{ field: 'body', name: 'ticketNumber', reason: 'unknown_variable' }]);
  });

  // Review api-comms-1: rows seeded before the Phase 3 wording change still use these names, and
  // the worker still fills them — saving such a row back (even unchanged) must not be refused.
  it('accepts the pre-rename names the P1 senders still provide (only on those templates)', () => {
    expect(legacyTemplateVariables('P1_ALERT')).toEqual(['escalationMins', 'consoleUrl']);
    expect(legacyTemplateVariables('P1_ESCALATION')).toEqual([
      'minutesUnacknowledged',
      'consoleUrl',
    ]);
    expect(legacyTemplateVariables('PASSWORD_RESET')).toEqual([]);
    expect(
      templatePlaceholderProblems('P1_ALERT', {
        subject: 'P1 CRITICAL [{{ticketNumber}}]',
        body: 'Open in the console: {{consoleUrl}}\nWithin {{escalationMins}} minutes.',
      }),
    ).toEqual([]);
    expect(
      templatePlaceholderProblems('P1_ESCALATION', {
        subject: 'unacknowledged for {{minutesUnacknowledged}} min',
        body: '{{minutesUnacknowledged}} minutes. {{consoleUrl}}',
      }),
    ).toEqual([]);
    // Another template's legacy name is still unknown.
    expect(
      templatePlaceholderProblems('P1_ESCALATION', { subject: '', body: '{{escalationMins}}' }),
    ).toEqual([{ field: 'body', name: 'escalationMins', reason: 'unknown_variable' }]);
  });

  // Review api-comms-3: text that looks like a placeholder but isn't one would be sent verbatim.
  it('refuses malformed placeholders (stray or unbalanced braces, invalid names)', () => {
    const problems = (subject: string, body = '') =>
      templatePlaceholderProblems('TICKET_CREATED_CLIENT', { subject, body });
    expect(problems('[{{ticket-number}}] {{ticketSubject}')).toEqual([
      { field: 'subject', name: '{{ticket-number}}', reason: 'malformed_placeholder' },
      { field: 'subject', name: '{{ticketSubject}', reason: 'malformed_placeholder' },
    ]);
    expect(problems('Ticket {{ticket number}}')).toEqual([
      { field: 'subject', name: '{{ticket number}}', reason: 'malformed_placeholder' },
    ]);
    expect(problems('{{ticketNumber}}}', '{{{name}} and {ticketNumber}} {{ticketSubject')).toEqual([
      { field: 'subject', name: '{{ticketNumber}}}', reason: 'malformed_placeholder' },
      { field: 'body', name: '{{{name}}', reason: 'malformed_placeholder' },
      { field: 'body', name: '{ticketNumber}}', reason: 'malformed_placeholder' },
      { field: 'body', name: '{{ticketSubject', reason: 'malformed_placeholder' },
    ]);
    // Valid placeholders (with spaces too) and single braces in prose are fine.
    expect(problems('[{{ ticketNumber }}] {{ticketSubject}}', 'Use {braces} freely: {x}')).toEqual(
      [],
    );
    // Unknown names are still reported by name.
    expect(problems('{{nope}} {{ticket-number}}')).toEqual([
      { field: 'subject', name: 'nope', reason: 'unknown_variable' },
      { field: 'subject', name: '{{ticket-number}}', reason: 'malformed_placeholder' },
    ]);
  });
});

describe('sample values', () => {
  it('gives a value for every declared variable of every template, in both languages', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const locale of ['en', 'ar'] as const) {
        const vars = sampleTemplateVariables(key, locale, { appUrl: APP });
        expect(Object.keys(vars).sort(), `${key} ${locale}`).toEqual(
          [...allowedTemplateVariables(key), ...legacyTemplateVariables(key)].sort(),
        );
        for (const [name, value] of Object.entries(vars)) {
          expect(value, `${key} ${locale} ${name}`).not.toBe('');
          expect(value, `${key} ${locale} ${name}`).not.toContain('{{');
        }
      }
    }
  });

  it('localises names and labels, and links point at the app', () => {
    const en = sampleTemplateVariables('TICKET_CREATED_TEAM', 'en', { appUrl: `${APP}/` });
    const ar = sampleTemplateVariables('TICKET_CREATED_TEAM', 'ar', { appUrl: APP });
    expect(en.priority).toBe('P1 Critical');
    expect(ar.priority).toBe('P1 حرجة');
    expect(en.teamName).toBe('ELV Field');
    expect(ar.teamName).toBe('الأنظمة منخفضة الجهد');
    expect(en.consoleUrl).toBe(`${APP}/console/inbox?ticket=LG-4821`);
    const client = sampleTemplateVariables('TICKET_CREATED_CLIENT', 'en', {
      appUrl: APP,
      socPhone: '+974 5555 0000',
    });
    expect(client.socPhone).toBe('+974 5555 0000');
  });
});

describe('renderEmailTemplatePreview', () => {
  it('renders the draft text with sample values, the CTA and the greeting', async () => {
    const out = await renderEmailTemplatePreview({
      key: 'AGENT_REPLY_CLIENT',
      locale: 'en',
      appUrl: APP,
      subject: 'Re: [{{ticketNumber}}] {{ticketSubject}}',
      body: 'Hi {{name}},\n\n{{agentName}} wrote:\n\n{{messageBody}}\n\nDraft wording here.',
    });
    expect(out.subject).toBe('Re: [LG-4821] Cameras offline in the car park');
    expect(out.text).toContain('Hi Dana Haddad,');
    expect(out.text).toContain('Omar Saleh wrote:');
    expect(out.text).toContain('Thanks — the cameras are back online.');
    expect(out.text).toContain('Draft wording here.');
    expect(out.html).toContain('Reply in the portal');
    expect(out.html).toContain(`${APP}/tickets/LG-4821`);
  });

  it('renders Arabic right-to-left, without a greeting for distribution lists', async () => {
    const ar = await renderEmailTemplatePreview({
      key: 'AGENT_REPLY_CLIENT',
      locale: 'ar',
      appUrl: APP,
      subject: '{{ticketNumber}}',
      body: 'مرحبًا {{name}}،\n\nنص تجريبي.',
    });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('دانة حداد');

    const list = await renderEmailTemplatePreview({
      key: 'TICKET_CREATED_TEAM',
      locale: 'en',
      appUrl: APP,
      subject: 'New {{priority}}',
      body: 'Hi {{name}},\n\nA new ticket for {{teamName}}.',
    });
    expect(list.text).not.toContain('Hi ,');
    expect(list.text).toContain('A new ticket for ELV Field.');
  });

  it('renders placeholders the template does not know as empty text', async () => {
    const out = await renderEmailTemplatePreview({
      key: 'PASSWORD_RESET',
      locale: 'en',
      appUrl: APP,
      subject: 'Reset {{nope}}now',
      body: 'Body {{nope}}text',
    });
    expect(out.subject).toBe('Reset now');
    expect(out.text).toContain('Body text');
  });
});
