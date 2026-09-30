// Admin — Email templates (spec §10.9; decision E14). The twelve fixed keys (EMAIL_TEMPLATE_KEYS
// in @loons/emails): edit, preview and reset only — no create or delete. Variables are listed from
// code (DEFAULT_EMAIL_TEMPLATES), unknown placeholders are refused (400 `unknown_variable`), block
// variables (description, messageBody, ticketList) only in the body (400 `block_in_subject`), and
// brace text that isn't a placeholder (`{{ticket-number}}`, `{{name}`) too (400
// `malformed_placeholder`).
//
// GET    /admin/email-templates                 → { items: EmailTemplateAdminDto[] }
// GET    /admin/email-templates/:key            → { item }
// PUT    /admin/email-templates/:key            → { item }   (creates the row when missing)
// POST   /admin/email-templates/:key/reset      → { item }   (back to the built-in text)
// POST   /admin/email-templates/:key/preview    → EmailTemplatePreviewDto (rendered by
//                                                 @loons/emails with sample values; not saved)
// Scope `email-templates`.

import { z } from 'zod';
import { LOCALES } from '../../enums.ts';
import { cleanText } from '../tickets.ts';
import { adminUserRefSchema, isoDateTime, itemListSchema, itemResponseSchema } from './common.ts';

export const EMAIL_TEMPLATE_LIMITS = { subjectMax: 200, bodyMax: 10_000 } as const;

export const EMAIL_TEMPLATE_AUDIENCES = ['user', 'list'] as const;

export const emailTemplateKeyParamSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
});

export const emailTemplateAdminDtoSchema = z.object({
  key: z.string(),
  subjectEn: z.string(),
  bodyEn: z.string(),
  subjectAr: z.string(),
  bodyAr: z.string(),
  /** The stored text differs from the built-in default ("Reset to default" is offered). */
  isCustomized: z.boolean(),
  /** Placeholders this template may use, from code. */
  variables: z.array(z.string()),
  /** Of those, the ones allowed only in the body (multi-line blocks). */
  blockVariables: z.array(z.string()),
  /**
   * Names from before a wording change that the sender still fills: accepted (a stored text that
   * uses them can be saved back) but not offered in the editor.
   */
  legacyVariables: z.array(z.string()),
  /** `user`: one person, greeted by name, in their language; `list`: a team list, English. */
  audience: z.enum(EMAIL_TEMPLATE_AUDIENCES),
  updatedBy: adminUserRefSchema.nullable(),
  /** null when no row is stored yet (the built-in text is used). */
  updatedAt: isoDateTime.nullable(),
});
export type EmailTemplateAdminDto = z.infer<typeof emailTemplateAdminDtoSchema>;

export const emailTemplateListSchema = itemListSchema(emailTemplateAdminDtoSchema);
export const emailTemplateResponseSchema = itemResponseSchema(emailTemplateAdminDtoSchema);

const subject = (required: boolean) =>
  cleanText()
    .min(required ? 1 : 0, { error: 'validation.required' })
    .max(EMAIL_TEMPLATE_LIMITS.subjectMax, { error: 'validation.tooLong' });
const body = (required: boolean) =>
  cleanText()
    .min(required ? 1 : 0, { error: 'validation.required' })
    .max(EMAIL_TEMPLATE_LIMITS.bodyMax, { error: 'validation.tooLong' });

/** Arabic may stay empty (the English text is sent, per template). */
export const updateEmailTemplateSchema = z.object({
  /** The template's `updatedAt` the edit started from; null when no row existed. */
  expectedUpdatedAt: isoDateTime.nullable(),
  subjectEn: subject(true),
  bodyEn: body(true),
  subjectAr: subject(false).default(''),
  bodyAr: body(false).default(''),
});
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;

export const resetEmailTemplateSchema = z.object({
  expectedUpdatedAt: isoDateTime.nullable(),
});
export type ResetEmailTemplateInput = z.infer<typeof resetEmailTemplateSchema>;

/** Renders a draft (not saved) in one language with sample values. */
export const previewEmailTemplateSchema = z.object({
  locale: z.enum(LOCALES),
  subject: subject(false),
  body: body(false),
});
export type PreviewEmailTemplateInput = z.infer<typeof previewEmailTemplateSchema>;

export const emailTemplatePreviewDtoSchema = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string(),
});
export type EmailTemplatePreviewDto = z.infer<typeof emailTemplatePreviewDtoSchema>;
