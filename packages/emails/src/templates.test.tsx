import { describe, expect, it } from 'vitest';
import type { Locale } from '@loons/shared';
import {
  AUTH_EMAIL_TEMPLATE_KEYS,
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  TICKET_EMAIL_TEMPLATE_KEYS,
  isEmailTemplateKey,
  type EmailTemplateKey,
} from './defaults.ts';
import { templateVariables } from './interpolate.ts';
import { LINK_VARIABLES } from './render.tsx';
import { renderEmailTemplate, resolveTemplateText } from './templates.ts';

const APP = 'https://help.example.com';
const URLS = {
  portalUrl: `${APP}/tickets/LG-4821`,
  consoleUrl: `${APP}/console/inbox?ticket=LG-4821`,
  ackUrl: `${APP}/console/inbox?ticket=LG-4821&focus=ack`,
  queueUrl: `${APP}/console/inbox?view=unassigned`,
  resetUrl: `${APP}/reset-password?token=r`,
  verifyUrl: `${APP}/verify-email/confirm?token=v`,
  signInUrl: `${APP}/login`,
};

/** The body paragraphs of the text part (between the subject and the footer). */
function bodyOf(text: string): string {
  const parts = text.split('\n\n—\n\n')[0] ?? '';
  return parts.slice(parts.indexOf('\n\n') + 2);
}

/** The href of the CTA button (the `<a>` whose text is `label`), unescaped. */
function buttonHref(html: string, label: string): string | undefined {
  const end = html.indexOf(`>${label}</span>`);
  if (end < 0) return undefined;
  const start = html.lastIndexOf('<a ', end);
  return /href="([^"]*)"/.exec(html.slice(start, end))?.[1]?.replace(/&amp;/g, '&');
}

/** A value for every variable any template declares. */
function sampleVariables(locale: Locale): Record<string, string | number> {
  return {
    ...URLS,
    name: locale === 'ar' ? 'ليلى' : 'Ada',
    agentName: 'Omar',
    requesterName: 'Dana Client',
    orgName: 'Qatar Airways',
    teamName: 'SOC',
    ticketNumber: 'LG-4821',
    ticketSubject: 'Cameras offline',
    ticketType: 'Incident',
    ticketStatus: 'Open',
    priority: 'P1 Critical',
    categoryName: 'CCTV',
    subtypeName: 'Camera offline',
    siteName: 'HQ',
    assetId: 'CAM-014',
    assigneeName: 'Unassigned',
    firstReplyDueAt: 'Tue, Sep 29, 2026, 14:05 GMT+3',
    createdAt: 'Tue, Sep 29, 2026, 13:50 GMT+3',
    dueAt: 'Tue, Sep 29, 2026, 14:05 GMT+3',
    description: 'Line one\nLine two',
    messageBody: 'Thanks,\nit works now.',
    ticketList: '• LG-1 · a\n• LG-2 · b',
    ticketCount: 2,
    digestDate: 'Sep 29, 2026',
    slaTarget: 'first reply',
    timeRemaining: '15 minutes',
    overdueBy: '5 minutes',
    targetResponse: '15 minutes',
    socPhone: '+974 4000 0000',
    escalationDelay: locale === 'ar' ? '5 دقائق' : '5 minutes',
    unacknowledgedFor: locale === 'ar' ? '5 دقائق' : '5 minutes',
    step: 2,
    expiresMinutes: 30,
    expiresHours: 24,
  };
}

const CTA_VARIABLE: Record<EmailTemplateKey, keyof typeof URLS> = {
  PASSWORD_RESET: 'resetUrl',
  EMAIL_VERIFICATION: 'verifyUrl',
  GOOGLE_LINKED: 'signInUrl',
  TICKET_CREATED_CLIENT: 'portalUrl',
  TICKET_CREATED_TEAM: 'consoleUrl',
  AGENT_REPLY_CLIENT: 'portalUrl',
  CLIENT_REPLY_ASSIGNEE: 'consoleUrl',
  SLA_AT_RISK: 'consoleUrl',
  SLA_BREACHED: 'consoleUrl',
  P1_ALERT: 'ackUrl',
  P1_ESCALATION: 'ackUrl',
  P4_DAILY_DIGEST: 'queueUrl',
};

describe('template keys', () => {
  it('has the three auth keys and the nine ticket keys', () => {
    expect(EMAIL_TEMPLATE_KEYS).toEqual([
      'PASSWORD_RESET',
      'EMAIL_VERIFICATION',
      'GOOGLE_LINKED',
      ...TICKET_EMAIL_TEMPLATE_KEYS,
    ]);
    expect(TICKET_EMAIL_TEMPLATE_KEYS).toHaveLength(9);
    expect(isEmailTemplateKey('P1_ALERT')).toBe(true);
    expect(isEmailTemplateKey('constructor')).toBe(false);
  });

  it('maps each key to its CTA link variable, with EN and AR labels', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const t = DEFAULT_EMAIL_TEMPLATES[key];
      expect(t.ctaUrlVariable, key).toBe(CTA_VARIABLE[key]);
      expect(LINK_VARIABLES as readonly string[], key).toContain(t.ctaUrlVariable);
      expect(t.ctaEn, key).toBeTruthy();
      expect(t.ctaAr, key).toBeTruthy();
    }
  });

  it('every placeholder is declared, and every declared variable is used (EN and AR)', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const t = DEFAULT_EMAIL_TEMPLATES[key];
      for (const [lang, text] of [
        ['en', `${t.subjectEn}\n${t.bodyEn}`],
        ['ar', `${t.subjectAr}\n${t.bodyAr}`],
      ] as const) {
        const used = templateVariables(text);
        for (const name of used) expect(t.variables, `${key} ${lang} {{${name}}}`).toContain(name);
        for (const name of t.variables) {
          // The auth defaults show their link as the button only.
          const authLink =
            (AUTH_EMAIL_TEMPLATE_KEYS as readonly string[]).includes(key) &&
            name === t.ctaUrlVariable;
          if (authLink) continue;
          expect(used, `${key} ${lang} declares ${name}`).toContain(name);
        }
      }
    }
  });

  it('distribution-list templates are TICKET_CREATED_TEAM and P4_DAILY_DIGEST', () => {
    expect(
      EMAIL_TEMPLATE_KEYS.filter((k) => DEFAULT_EMAIL_TEMPLATES[k].audience === 'list'),
    ).toEqual(['TICKET_CREATED_TEAM', 'P4_DAILY_DIGEST']);
  });
});

describe('renderEmailTemplate: every ticket template in English and Arabic', () => {
  for (const key of TICKET_EMAIL_TEMPLATE_KEYS) {
    for (const locale of ['en', 'ar'] as const) {
      it(`${key} (${locale})`, async () => {
        const out = await renderEmailTemplate({ key, locale, variables: sampleVariables(locale) });
        const url = URLS[CTA_VARIABLE[key]];
        expect(out.html).toMatch(new RegExp(`<html[^>]*dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`));
        expect(out.html).toMatch(new RegExp(`<html[^>]*lang="${locale}"`));
        for (const part of [out.subject, out.text, out.html]) expect(part).not.toContain('{{');
        expect(out.subject).toContain(key === 'P4_DAILY_DIGEST' ? 'SOC' : 'LG-4821');
        // The CTA button points at the key's link variable, and the URL is shown once in the body
        // (so no "copy this link" fallback is added).
        const label = DEFAULT_EMAIL_TEMPLATES[key][locale === 'ar' ? 'ctaAr' : 'ctaEn'] ?? '';
        expect(buttonHref(out.html, label)).toBe(url);
        expect(out.text.split(url).length - 1).toBe(1);
        const personal = DEFAULT_EMAIL_TEMPLATES[key].audience === 'user';
        const greeting = locale === 'ar' ? 'مرحبًا ليلى،' : 'Hi Ada,';
        if (personal) expect(out.text).toContain(greeting);
        else expect(out.text).not.toContain(greeting);
        // Arabic copy never uses the Latin name (the layout's wordmark and footer are separate).
        if (locale === 'ar') expect(`${out.subject}\n${bodyOf(out.text)}`).not.toMatch(/Loons/);
      });
    }
  }

  it('keeps block variables multi-line and never linkifies them', async () => {
    const out = await renderEmailTemplate({
      key: 'TICKET_CREATED_TEAM',
      locale: 'en',
      variables: {
        ...sampleVariables('en'),
        description: 'Cameras 1-4 down.\nSee https://evil.example/fix\n\nStarted 08:00.',
      },
    });
    expect(out.text).toContain(
      'First reply due: Tue, Sep 29, 2026, 14:05 GMT+3\n\nCameras 1-4 down.\nSee https://evil.example/fix\n\nStarted 08:00.\n\nOpen it in the console:',
    );
    expect(out.html).not.toContain('href="https://evil.example');
  });

  it('points the "shortened" line at the portal for clients and the console for staff', async () => {
    const long = 'm'.repeat(2100);
    const client = await renderEmailTemplate({
      key: 'AGENT_REPLY_CLIENT',
      locale: 'en',
      variables: { ...sampleVariables('en'), messageBody: long },
    });
    expect(client.text).toContain('View the full message in the portal.');
    const staff = await renderEmailTemplate({
      key: 'CLIENT_REPLY_ASSIGNEE',
      locale: 'ar',
      variables: { ...sampleVariables('ar'), messageBody: long },
    });
    expect(staff.text).toContain('اطّلع على الرسالة كاملة في وحدة التحكم.');
    const digest = await renderEmailTemplate({
      key: 'P4_DAILY_DIGEST',
      locale: 'en',
      variables: { ...sampleVariables('en'), ticketList: '• LG-1 · x\n'.repeat(250) },
    });
    expect(digest.text).toContain('This list has been shortened. View all tickets in the console.');
  });
});

describe('renderEmailTemplate: greeting-less rendering for distribution lists', () => {
  it('TICKET_CREATED_TEAM starts with the routing line (no personal greeting)', async () => {
    const out = await renderEmailTemplate({
      key: 'TICKET_CREATED_TEAM',
      locale: 'en',
      variables: sampleVariables('en'),
    });
    expect(out.text.split('\n\n')[1]).toBe('A new ticket has been routed to SOC.');
  });

  it('P4_DAILY_DIGEST greets the team, not a person', async () => {
    const out = await renderEmailTemplate({
      key: 'P4_DAILY_DIGEST',
      locale: 'en',
      variables: sampleVariables('en'),
    });
    expect(out.text.split('\n\n')[1]).toBe('Hello SOC team,');
    expect(out.text).toContain('• LG-1 · a\n• LG-2 · b');
  });

  it('a stored list template that adds "Hi {{name}}," still renders without it', async () => {
    const t = DEFAULT_EMAIL_TEMPLATES.TICKET_CREATED_TEAM;
    const out = await renderEmailTemplate({
      key: 'TICKET_CREATED_TEAM',
      locale: 'en',
      variables: sampleVariables('en'),
      stored: { ...t, bodyEn: `Hi {{name}},\n\n${t.bodyEn}`, isActive: true },
    });
    expect(out.text).not.toContain('Hi ');
    expect(out.text.split('\n\n')[1]).toBe('A new ticket has been routed to SOC.');
  });

  it('CLIENT_REPLY_ASSIGNEE to the team list (unassigned, D6) drops "Hi {{name}},"', async () => {
    const vars = { ...sampleVariables('en') };
    const toAssignee = await renderEmailTemplate({
      key: 'CLIENT_REPLY_ASSIGNEE',
      locale: 'en',
      variables: vars,
    });
    expect(toAssignee.text.split('\n\n')[1]).toBe('Hi Ada,');
    const toList = await renderEmailTemplate({
      key: 'CLIENT_REPLY_ASSIGNEE',
      locale: 'en',
      variables: vars,
      audience: 'list',
    });
    expect(toList.text.split('\n\n')[1]).toBe('Dana Client (Qatar Airways) replied on LG-4821:');
  });
});

describe('stored row or built-in default', () => {
  const t = DEFAULT_EMAIL_TEMPLATES.SLA_BREACHED;
  const stored = {
    subjectEn: 'Custom {{ticketNumber}}',
    bodyEn: 'Custom body {{ticketNumber}}',
    subjectAr: 'مخصص {{ticketNumber}}',
    bodyAr: 'نص مخصص {{ticketNumber}}',
    isActive: true,
  };

  it('uses an active row with English text', () => {
    expect(resolveTemplateText('SLA_BREACHED', stored)).toBe(stored);
  });

  it('falls back to the default when the row is missing, archived or has no English text', () => {
    expect(resolveTemplateText('SLA_BREACHED', null)).toBe(t);
    expect(resolveTemplateText('SLA_BREACHED', undefined)).toBe(t);
    expect(resolveTemplateText('SLA_BREACHED', { ...stored, isActive: false })).toBe(t);
    expect(resolveTemplateText('SLA_BREACHED', { ...stored, subjectEn: ' ' })).toBe(t);
    expect(resolveTemplateText('SLA_BREACHED', { ...stored, bodyEn: '' })).toBe(t);
  });

  it('renders the stored row, the default for an archived row, English for empty Arabic', async () => {
    const vars = sampleVariables('ar');
    const custom = await renderEmailTemplate({
      key: 'SLA_BREACHED',
      locale: 'ar',
      variables: vars,
      stored,
    });
    expect(custom.subject).toBe('مخصص LG-4821');
    // The CTA label and URL still come from code.
    expect(buttonHref(custom.html, 'فتح التذكرة')).toBe(URLS.consoleUrl);
    expect(custom.text).toContain(`فتح التذكرة: ${URLS.consoleUrl}`);

    const archived = await renderEmailTemplate({
      key: 'SLA_BREACHED',
      locale: 'ar',
      variables: vars,
      stored: { ...stored, isActive: false },
    });
    expect(archived.subject).toBe('[LG-4821] تجاوز مهلة الخدمة — first reply متأخر');

    const noArabic = await renderEmailTemplate({
      key: 'SLA_BREACHED',
      locale: 'ar',
      variables: vars,
      stored: { ...stored, bodyAr: '' },
    });
    expect(noArabic.subject).toBe('Custom LG-4821');
    expect(noArabic.html).toMatch(/<html[^>]*dir="ltr"/);
    expect(noArabic.text).toContain(`Open ticket: ${URLS.consoleUrl}`);
  });

  it('ctaUrl overrides the variable; no URL means no button', async () => {
    const other = `${APP}/console/inbox?ticket=LG-1`;
    const out = await renderEmailTemplate({
      key: 'SLA_AT_RISK',
      locale: 'en',
      variables: sampleVariables('en'),
      ctaUrl: other,
    });
    expect(buttonHref(out.html, 'Open ticket')).toBe(other);
    const none = await renderEmailTemplate({
      key: 'SLA_AT_RISK',
      locale: 'en',
      variables: { ...sampleVariables('en'), consoleUrl: '' },
    });
    expect(buttonHref(none.html, 'Open ticket')).toBeUndefined();
  });
});

describe('wording follow-ups (integration)', () => {
  it('P1 emails: one acknowledge line (ackUrl opens the console) and durations in the reader’s language', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const alert = await renderEmailTemplate({
        key: 'P1_ALERT',
        locale,
        variables: sampleVariables(locale),
      });
      expect(alert.text).toContain(URLS.ackUrl);
      expect(alert.text).not.toContain(
        locale === 'ar' ? 'فتح في وحدة التحكم' : 'Open in the console',
      );
      expect(alert.text).toContain(locale === 'ar' ? 'خلال 5 دقائق،' : 'within 5 minutes,');
      const escalation = await renderEmailTemplate({
        key: 'P1_ESCALATION',
        locale,
        variables: sampleVariables(locale),
      });
      expect(escalation.subject).toContain(
        locale === 'ar' ? 'دون تأكيد استلام منذ 5 دقائق' : 'unacknowledged for 5 minutes',
      );
    }
    expect(DEFAULT_EMAIL_TEMPLATES.P1_ALERT.variables).not.toContain('escalationMins');
    expect(DEFAULT_EMAIL_TEMPLATES.P1_ESCALATION.variables).toContain('unacknowledgedFor');
  });

  it('the P4 digest says "since the last digest" (its window can span a weekend, D9)', () => {
    expect(DEFAULT_EMAIL_TEMPLATES.P4_DAILY_DIGEST.bodyEn).toContain('since the last digest');
    expect(DEFAULT_EMAIL_TEMPLATES.P4_DAILY_DIGEST.bodyAr).toContain('منذ الملخص السابق');
  });
});
