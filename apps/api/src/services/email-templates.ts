import type { PrismaClient } from '@loons/db';
import {
  DEFAULT_EMAIL_TEMPLATES,
  defaultCtaLabel,
  pickTemplateText,
  renderTemplateEmail,
  type EmailTemplateKey,
  type RenderedEmail,
  type TemplateVariables,
} from '@loons/emails';
import type { Locale } from '@loons/shared';

/**
 * Renders a transactional email from its admin-editable `EmailTemplate` row, or from the built-in
 * default when the row is missing, archived or empty. The button (CTA) label comes from code.
 */
export async function renderStoredTemplate(
  prisma: PrismaClient,
  key: EmailTemplateKey,
  args: { locale: Locale; variables: TemplateVariables; ctaUrl: string },
): Promise<RenderedEmail> {
  const row = await prisma.emailTemplate.findUnique({
    where: { key },
    select: { subjectEn: true, bodyEn: true, subjectAr: true, bodyAr: true, isActive: true },
  });
  const usable = row && row.isActive && row.subjectEn.trim() !== '' && row.bodyEn.trim() !== '';
  const fallback = DEFAULT_EMAIL_TEMPLATES[key];
  const text = pickTemplateText(usable ? row : fallback, args.locale);
  return renderTemplateEmail({
    locale: text.locale,
    subject: text.subject,
    body: text.body,
    variables: args.variables,
    cta: { label: defaultCtaLabel(key, text.locale) ?? fallback.ctaEn ?? '', url: args.ctaUrl },
  });
}
