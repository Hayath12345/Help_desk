import type { PrismaClient } from '@loons/db';
import {
  renderEmailTemplate,
  type EmailTemplateKey,
  type RenderedEmail,
  type TemplateAudience,
  type TemplateVariables,
} from '@loons/emails';
import type { Locale } from '@loons/shared';

/**
 * Renders a transactional email from its admin-editable `EmailTemplate` row, or from the built-in
 * default when the row is missing, archived or empty (`@loons/emails` renderEmailTemplate: CTA
 * label from code, CTA URL from the template's link variable unless `ctaUrl` overrides it,
 * greeting-less for distribution lists). The worker renders ticket emails the same way.
 */
export async function renderStoredTemplate(
  prisma: PrismaClient,
  key: EmailTemplateKey,
  args: {
    locale: Locale;
    variables: TemplateVariables;
    ctaUrl?: string;
    audience?: TemplateAudience;
  },
): Promise<RenderedEmail> {
  const stored = await prisma.emailTemplate.findUnique({
    where: { key },
    select: { subjectEn: true, bodyEn: true, subjectAr: true, bodyAr: true, isActive: true },
  });
  return renderEmailTemplate({
    key,
    locale: args.locale,
    variables: args.variables,
    stored,
    ...(args.ctaUrl ? { ctaUrl: args.ctaUrl } : {}),
    ...(args.audience ? { audience: args.audience } : {}),
  });
}
