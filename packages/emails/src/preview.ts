// The admin template editor (Phase 4, decision E14): which placeholders a template may use where,
// and a preview of draft text rendered exactly like a sent email (layout, CTA, greeting rules)
// with made-up sample values. Nothing here reads or writes the database.

import type { Locale } from '@loons/shared';
import { isBlockVariable } from './blocks.ts';
import { DEFAULT_EMAIL_TEMPLATES, defaultCtaLabel, type EmailTemplateKey } from './defaults.ts';
import {
  buildTicketList,
  formatDurationMinutes,
  formatEmailDate,
  formatTargetDuration,
  slaTargetLabel,
  ticketLinks,
  ticketTemplateVariables,
} from './format.ts';
import { malformedPlaceholders, templateVariables } from './interpolate.ts';
import { renderTemplateEmail, type RenderedEmail } from './render.tsx';

export type TemplatePlaceholderReason =
  'unknown_variable' | 'block_in_subject' | 'malformed_placeholder';

export interface TemplatePlaceholderProblem {
  field: 'subject' | 'body';
  /** The placeholder's name (`{{name}}` → `name`); for `malformed_placeholder` the text as typed. */
  name: string;
  reason: TemplatePlaceholderReason;
}

/** The placeholders `key` may use (from code, never from the stored row). */
export function allowedTemplateVariables(key: EmailTemplateKey): readonly string[] {
  return DEFAULT_EMAIL_TEMPLATES[key].variables;
}

/**
 * Names from before the Phase 3 wording change that the senders still fill (deliver.ts; the link
 * variables come from `ticketLinks`). Rows seeded earlier use them and the seed never rewrites a
 * row, so they stay accepted — an unchanged save of such a row must not be refused — but the
 * editor doesn't offer them.
 */
const LEGACY_TEMPLATE_VARIABLES: Partial<Record<EmailTemplateKey, readonly string[]>> = {
  P1_ALERT: ['escalationMins', 'consoleUrl'],
  P1_ESCALATION: ['minutesUnacknowledged', 'consoleUrl'],
};

/** The deprecated names `key` still accepts (see LEGACY_TEMPLATE_VARIABLES). */
export function legacyTemplateVariables(key: EmailTemplateKey): readonly string[] {
  return LEGACY_TEMPLATE_VARIABLES[key] ?? [];
}

/** Of those, the multi-line block variables (body only: a subject is one line). */
export function templateBlockVariables(key: EmailTemplateKey): string[] {
  return allowedTemplateVariables(key).filter((name) => isBlockVariable(name));
}

/**
 * Placeholders a draft may not use: names the template's sender doesn't provide
 * (`unknown_variable`, subject or body), block variables in the subject (`block_in_subject`) and
 * brace text that isn't a placeholder, which would be sent as typed (`malformed_placeholder`).
 * Empty when the text is fine. Each name (or fragment) is reported once per field.
 */
export function templatePlaceholderProblems(
  key: EmailTemplateKey,
  text: { subject: string; body: string },
): TemplatePlaceholderProblem[] {
  const allowed = new Set([...allowedTemplateVariables(key), ...legacyTemplateVariables(key)]);
  const problems: TemplatePlaceholderProblem[] = [];
  for (const field of ['subject', 'body'] as const) {
    for (const name of templateVariables(text[field])) {
      if (!allowed.has(name)) problems.push({ field, name, reason: 'unknown_variable' });
      else if (field === 'subject' && isBlockVariable(name)) {
        problems.push({ field, name, reason: 'block_in_subject' });
      }
    }
    for (const name of malformedPlaceholders(text[field])) {
      problems.push({ field, name, reason: 'malformed_placeholder' });
    }
  }
  return problems;
}

/** When the sample ticket was raised (a fixed instant, so previews are stable). */
const SAMPLE_CREATED_AT = new Date('2026-09-29T10:50:00.000Z');
const SAMPLE_FIRST_REPLY_DUE = new Date('2026-09-29T11:05:00.000Z');

const SAMPLE_PEOPLE: Readonly<Record<Locale, { name: string; agent: string; requester: string }>> =
  {
    en: { name: 'Dana Haddad', agent: 'Omar Saleh', requester: 'Dana Haddad' },
    ar: { name: 'دانة حداد', agent: 'عمر صالح', requester: 'دانة حداد' },
  };

const SAMPLE_TEXT: Readonly<
  Record<Locale, { subject: string; description: string; message: string }>
> = {
  en: {
    subject: 'Cameras offline in the car park',
    description:
      'Cameras CAM-014 and CAM-015 stopped recording at 09:40.\nThe NVR shows “no signal”.',
    message: 'Thanks — the cameras are back online.\nWe will keep monitoring them today.',
  },
  ar: {
    subject: 'الكاميرات متوقفة في موقف السيارات',
    description:
      'توقفت الكاميرتان CAM-014 وCAM-015 عن التسجيل الساعة 09:40.\nيعرض جهاز NVR «لا توجد إشارة».',
    message: 'شكرًا — عادت الكاميرات إلى العمل.\nسنواصل مراقبتها اليوم.',
  },
};

export interface SampleVariablesOptions {
  /** APP_URL: the links point at this app (they are never followed from a preview). */
  appUrl: string;
  /** IANA zone for the sample dates (default Asia/Qatar). */
  timeZone?: string;
  /** The configured SOC phone (default a made-up number). */
  socPhone?: string;
}

/**
 * A made-up value for every variable any template declares, in `locale` (names, labels and dates
 * formatted the way the real senders format them). Only the variables `key` declares (and its
 * legacy names, which the senders still fill) are returned.
 */
export function sampleTemplateVariables(
  key: EmailTemplateKey,
  locale: Locale,
  options: SampleVariablesOptions,
): Record<string, string> {
  const timeZone = options.timeZone ?? 'Asia/Qatar';
  const people = SAMPLE_PEOPLE[locale];
  const text = SAMPLE_TEXT[locale];
  const number = 'LG-4821';
  const app = options.appUrl.replace(/\/+$/, '');
  const ticket = ticketTemplateVariables(
    {
      number,
      subject: text.subject,
      type: 'INCIDENT',
      priority: 'P1',
      status: 'OPEN',
      teamName: { en: 'ELV Field', ar: 'الأنظمة منخفضة الجهد' },
      categoryName: { en: 'CCTV & Video Surveillance', ar: 'كاميرات المراقبة' },
      subtypeName: { en: 'Camera offline', ar: 'كاميرا متوقفة' },
      orgName: { en: 'Hamad Medical Corporation', ar: 'مؤسسة حمد الطبية' },
      requesterName: people.requester,
      siteName: { en: 'Building 3, Level 2', ar: 'المبنى 3، الطابق 2' },
      assetId: 'CAM-014',
      assigneeName: people.agent,
      createdAt: SAMPLE_CREATED_AT,
      firstReplyDueAt: SAMPLE_FIRST_REPLY_DUE,
      description: text.description,
    },
    { locale, timeZone },
  );
  const all: Record<string, string> = {
    ...ticket,
    ...ticketLinks(app, number),
    name: people.name,
    agentName: people.agent,
    messageBody: text.message,
    dueAt: ticket.firstReplyDueAt ?? '',
    slaTarget: slaTargetLabel('FIRST_REPLY', locale),
    timeRemaining: formatDurationMinutes(4, locale),
    overdueBy: formatDurationMinutes(12, locale),
    targetResponse: formatTargetDuration(15, false, locale),
    socPhone: options.socPhone?.trim() || '+974 4000 0000',
    escalationDelay: formatDurationMinutes(10, locale),
    unacknowledgedFor: formatDurationMinutes(10, locale),
    // The legacy bare numbers (LEGACY_TEMPLATE_VARIABLES), as the P1 senders still fill them.
    escalationMins: '10',
    minutesUnacknowledged: '10',
    step: '2',
    ticketCount: '2',
    digestDate: formatEmailDate(SAMPLE_CREATED_AT, locale, timeZone),
    ticketList: buildTicketList(
      [
        {
          number: 'LG-4818',
          subject: SAMPLE_TEXT[locale].subject,
          orgName: { en: 'QNB', ar: 'QNB' },
          createdAt: SAMPLE_CREATED_AT,
        },
        {
          number: 'LG-4819',
          subject: locale === 'ar' ? 'طلب بطاقة دخول جديدة' : 'New access card request',
          orgName: { en: 'Hamad Medical Corporation', ar: 'مؤسسة حمد الطبية' },
          createdAt: SAMPLE_CREATED_AT,
        },
      ],
      { locale, timeZone },
    ),
    queueUrl: `${app}/console/inbox?view=unassigned`,
    resetUrl: `${app}/reset-password?token=preview`,
    verifyUrl: `${app}/verify-email/confirm?token=preview`,
    signInUrl: `${app}/login`,
    expiresMinutes: '30',
    expiresHours: '24',
  };
  return Object.fromEntries(
    [...allowedTemplateVariables(key), ...legacyTemplateVariables(key)].map((name) => [
      name,
      all[name] ?? `{{${name}}}`,
    ]),
  );
}

export interface RenderEmailTemplatePreviewInput extends SampleVariablesOptions {
  key: EmailTemplateKey;
  /** The language of the draft text (the preview never falls back to the other language). */
  locale: Locale;
  subject: string;
  body: string;
}

/**
 * Renders unsaved template text for `key` like `renderEmailTemplate` sends it (CTA label and
 * target, no greeting for distribution lists, "view the full message in …" for shortened blocks),
 * with `sampleTemplateVariables`. Placeholders the template doesn't know render empty, as they
 * would in a sent email (the editor refuses to save them).
 */
export async function renderEmailTemplatePreview(
  input: RenderEmailTemplatePreviewInput,
): Promise<RenderedEmail> {
  const template = DEFAULT_EMAIL_TEMPLATES[input.key];
  const variables = sampleTemplateVariables(input.key, input.locale, input);
  const ctaUrl = variables[template.ctaUrlVariable];
  const ctaLabel = defaultCtaLabel(input.key, input.locale) ?? '';
  return renderTemplateEmail({
    locale: input.locale,
    subject: input.subject,
    body: input.body,
    variables,
    ...(ctaUrl && ctaLabel ? { cta: { label: ctaLabel, url: ctaUrl } } : {}),
    greeting: template.audience === 'user',
    ...(template.surface ? { viewFullIn: template.surface } : {}),
  });
}
