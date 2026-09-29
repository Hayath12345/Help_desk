// Key-aware rendering: picks the stored `EmailTemplate` row or the built-in default, the language,
// the CTA (label from code, URL from the template's link variable), the greeting and the
// "view the full message in …" surface. The API's `renderStoredTemplate` reads the row and hands
// it here, so the worker and the request handlers render every template the same way.

import type { Locale } from '@loons/shared';
import {
  DEFAULT_EMAIL_TEMPLATES,
  defaultCtaLabel,
  pickTemplateText,
  type EmailTemplateKey,
  type EmailTemplateText,
  type TemplateAudience,
} from './defaults.ts';
import { variableText, type TemplateVariables } from './interpolate.ts';
import { renderTemplateEmail, type RenderedEmail } from './render.tsx';

/** The editable columns of an `EmailTemplate` row (plus `isActive`, false = archived). */
export interface StoredEmailTemplate extends EmailTemplateText {
  isActive: boolean;
}

/**
 * The text to render: the stored row when it exists, is active and has English text; otherwise
 * the built-in default for `key`.
 */
export function resolveTemplateText(
  key: EmailTemplateKey,
  stored: StoredEmailTemplate | null | undefined,
): EmailTemplateText {
  const usable =
    stored && stored.isActive && stored.subjectEn.trim() !== '' && stored.bodyEn.trim() !== '';
  return usable ? stored : DEFAULT_EMAIL_TEMPLATES[key];
}

export interface RenderEmailTemplateInput {
  key: EmailTemplateKey;
  /** The recipient's `User.locale`; a distribution list is English (D7). */
  locale: Locale;
  variables: TemplateVariables;
  /** The `EmailTemplate` row for `key`, or null when there is none. */
  stored?: StoredEmailTemplate | null;
  /**
   * Overrides the template's audience: CLIENT_REPLY_ASSIGNEE on an unassigned ticket goes to the
   * team list (D6), so it is rendered with `'list'` (no "Hi {{name}}," line).
   */
  audience?: TemplateAudience;
  /** Overrides the CTA target (default: the template's `ctaUrlVariable` value). */
  ctaUrl?: string;
}

/**
 * Renders `key` for one recipient: stored text or default, Arabic falling back to English when
 * the Arabic text is empty, CTA label from code and URL from the template's link variable
 * (portalUrl / consoleUrl / ackUrl / queueUrl / …), no personal greeting for distribution lists,
 * and block variables cut with a line pointing at the portal (client templates) or the console
 * (staff templates).
 */
export async function renderEmailTemplate(input: RenderEmailTemplateInput): Promise<RenderedEmail> {
  const template = DEFAULT_EMAIL_TEMPLATES[input.key];
  const text = pickTemplateText(resolveTemplateText(input.key, input.stored), input.locale);
  const ctaUrl = input.ctaUrl ?? variableText(input.variables, template.ctaUrlVariable);
  const ctaLabel = defaultCtaLabel(input.key, text.locale) ?? '';
  const audience = input.audience ?? template.audience;
  return renderTemplateEmail({
    locale: text.locale,
    subject: text.subject,
    body: text.body,
    variables: input.variables,
    ...(ctaUrl && ctaLabel ? { cta: { label: ctaLabel, url: ctaUrl } } : {}),
    greeting: audience === 'user',
    ...(template.surface ? { viewFullIn: template.surface } : {}),
  });
}
