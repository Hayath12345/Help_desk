import type { Prisma } from '@loons/db';
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_KEYS,
  isEmailTemplateKey,
  legacyTemplateVariables,
  renderEmailTemplatePreview,
  resolveTemplateText,
  templateBlockVariables,
  templatePlaceholderProblems,
  type EmailTemplateKey,
  type EmailTemplateText,
  type TemplatePlaceholderReason,
} from '@loons/emails';
import type {
  EmailTemplateAdminDto,
  EmailTemplatePreviewDto,
  PreviewEmailTemplateInput,
  ResetEmailTemplateInput,
  UpdateEmailTemplateInput,
} from '@loons/shared';
import { errors, type ValidationIssue } from '../../lib/errors.ts';
import { requireSuperAdmin } from './authz.ts';
import { advisoryLock, lockRow, sameInstant } from './concurrency.ts';
import type { AdminDeps } from './deps.ts';
import { adminErrors } from './errors.ts';
import type { AdminContext } from './write.ts';

// Admin — Email templates (spec §10.9; decision E14). The twelve keys are fixed in code
// (EMAIL_TEMPLATE_KEYS): no create or delete. A template's stored `EmailTemplate` row overrides
// the built-in text (`DEFAULT_EMAIL_TEMPLATES`) when it is active and has English text — the same
// rule the senders use (`resolveTemplateText`), so the editor always shows what is sent.
// - Saving writes (or creates) the row: all four texts, `variables` refreshed from code,
//   `isActive` true, `updatedById`. Placeholders the key's sender doesn't provide are refused
//   (400 `unknown_variable`), block variables in a subject too (400 `block_in_subject`), and brace
//   text that isn't a placeholder (400 `malformed_placeholder`). The pre-rename P1 names the
//   senders still fill (`legacyTemplateVariables`) are accepted: rows seeded before the rename
//   keep them, and saving such a row back must work.
// - "Reset to default" copies the built-in text into the row.
// - Stale edits: `expectedUpdatedAt` is the row's `updatedAt`, or null when no row existed; the row
//   (or, when missing, the key) is locked and compared (409 `stale`).
// - Preview renders unsaved text with sample values (@loons/emails); nothing is stored.
// Audit: UPDATE on entity `EmailTemplate` (id of the row, label = key) with the changed texts.
// Scope `email-templates` (admin lists only; senders read the row on every send).

type Tx = Prisma.TransactionClient;

const TEXT_FIELDS = ['subjectEn', 'bodyEn', 'subjectAr', 'bodyAr'] as const;
type TextField = (typeof TEXT_FIELDS)[number];

const templateSelect = {
  id: true,
  key: true,
  subjectEn: true,
  bodyEn: true,
  subjectAr: true,
  bodyAr: true,
  isActive: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.EmailTemplateSelect;

type TemplateRow = Prisma.EmailTemplateGetPayload<{ select: typeof templateSelect }>;

function builtInText(key: EmailTemplateKey): EmailTemplateText {
  const t = DEFAULT_EMAIL_TEMPLATES[key];
  return { subjectEn: t.subjectEn, bodyEn: t.bodyEn, subjectAr: t.subjectAr, bodyAr: t.bodyAr };
}

function pickText(text: EmailTemplateText): EmailTemplateText {
  return {
    subjectEn: text.subjectEn,
    bodyEn: text.bodyEn,
    subjectAr: text.subjectAr,
    bodyAr: text.bodyAr,
  };
}

function sameText(a: EmailTemplateText, b: EmailTemplateText): boolean {
  return TEXT_FIELDS.every((field) => a[field] === b[field]);
}

/** The text the senders use for `key` given its row (the built-in text when unusable). */
function effectiveText(key: EmailTemplateKey, row: TemplateRow | null): EmailTemplateText {
  return pickText(resolveTemplateText(key, row));
}

export function toEmailTemplateDto(
  key: EmailTemplateKey,
  row: TemplateRow | null,
): EmailTemplateAdminDto {
  const text = effectiveText(key, row);
  const template = DEFAULT_EMAIL_TEMPLATES[key];
  return {
    key,
    ...text,
    isCustomized: !sameText(text, builtInText(key)),
    variables: [...template.variables],
    blockVariables: templateBlockVariables(key),
    legacyVariables: [...legacyTemplateVariables(key)],
    audience: template.audience,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

const PROBLEM_MESSAGES: Readonly<Record<TemplatePlaceholderReason, string>> = {
  unknown_variable: 'validation.unknownVariable',
  block_in_subject: 'validation.blockInSubject',
  malformed_placeholder: 'validation.malformedPlaceholder',
};

/** 400 VALIDATION_FAILED listing every refused placeholder, per field. */
function placeholderIssues(key: EmailTemplateKey, text: EmailTemplateText): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [subjectField, bodyField] of [
    ['subjectEn', 'bodyEn'],
    ['subjectAr', 'bodyAr'],
  ] as const) {
    const problems = templatePlaceholderProblems(key, {
      subject: text[subjectField],
      body: text[bodyField],
    });
    for (const problem of problems) {
      const field: TextField = problem.field === 'subject' ? subjectField : bodyField;
      issues.push({
        location: 'body',
        path: [field],
        message: PROBLEM_MESSAGES[problem.reason],
        code: problem.reason,
      });
    }
  }
  return issues;
}

function templateKey(value: string): EmailTemplateKey {
  if (!isEmailTemplateKey(value)) throw errors.notFound('No such email template.');
  return value;
}

export interface EmailTemplatesAdminService {
  list(ctx: AdminContext): Promise<EmailTemplateAdminDto[]>;
  get(ctx: AdminContext, key: string): Promise<EmailTemplateAdminDto>;
  update(
    ctx: AdminContext,
    key: string,
    input: UpdateEmailTemplateInput,
  ): Promise<EmailTemplateAdminDto>;
  reset(
    ctx: AdminContext,
    key: string,
    input: ResetEmailTemplateInput,
  ): Promise<EmailTemplateAdminDto>;
  preview(
    ctx: AdminContext,
    key: string,
    input: PreviewEmailTemplateInput,
  ): Promise<EmailTemplatePreviewDto>;
}

export function createEmailTemplatesAdminService(deps: AdminDeps): EmailTemplatesAdminService {
  const { prisma, writer, config, ticketConfig } = deps;

  /**
   * Locks the key (a row may not exist yet: two first saves must not both insert) and the row,
   * then checks `expectedUpdatedAt` (null = "there was no row").
   */
  async function lockTemplate(
    tx: Tx,
    key: EmailTemplateKey,
    expectedUpdatedAt: string | null,
  ): Promise<TemplateRow | null> {
    await advisoryLock(tx, `EmailTemplate:${key}`);
    const locked = await lockRow(tx, 'EmailTemplate', key, 'key');
    if (locked === null) {
      if (expectedUpdatedAt !== null) throw adminErrors.stale(null);
      return null;
    }
    if (expectedUpdatedAt === null || !sameInstant(locked.updatedAt, expectedUpdatedAt)) {
      throw adminErrors.stale(locked.updatedAt);
    }
    return tx.emailTemplate.findUnique({ where: { key }, select: templateSelect });
  }

  /** Writes `text` as the key's row (created when missing) and audits the changed texts. */
  async function saveText(
    ctx: AdminContext,
    key: EmailTemplateKey,
    expectedUpdatedAt: string | null,
    next: EmailTemplateText,
  ): Promise<EmailTemplateAdminDto> {
    return writer.write(ctx, { scopes: [] }, async ({ tx, audit, after }) => {
      const row = await lockTemplate(tx, key, expectedUpdatedAt);
      const before = effectiveText(key, row);
      // Nothing to write: the row already holds this text (or, without a row, the built-in text
      // is what the admin sent back).
      if ((row === null || row.isActive) && sameText(before, next)) {
        return toEmailTemplateDto(key, row);
      }
      const data = {
        ...next,
        variables: [...DEFAULT_EMAIL_TEMPLATES[key].variables],
        isActive: true,
        updatedById: ctx.actor.id,
      };
      const saved = await tx.emailTemplate.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
        select: templateSelect,
      });
      await audit.record({
        action: 'UPDATE',
        entity: 'EmailTemplate',
        entityId: saved.id,
        entityLabel: key,
        before: { ...before, isActive: row ? row.isActive : true },
        after: { ...pickText(saved), isActive: saved.isActive },
      });
      after.scope('email-templates');
      return toEmailTemplateDto(key, saved);
    });
  }

  return {
    async list(ctx) {
      requireSuperAdmin(ctx.actor);
      const rows = await prisma.emailTemplate.findMany({
        where: { key: { in: [...EMAIL_TEMPLATE_KEYS] } },
        select: templateSelect,
      });
      const byKey = new Map(rows.map((row) => [row.key, row]));
      return EMAIL_TEMPLATE_KEYS.map((key) => toEmailTemplateDto(key, byKey.get(key) ?? null));
    },

    async get(ctx, rawKey) {
      requireSuperAdmin(ctx.actor);
      const key = templateKey(rawKey);
      const row = await prisma.emailTemplate.findUnique({ where: { key }, select: templateSelect });
      return toEmailTemplateDto(key, row);
    },

    async update(ctx, rawKey, input) {
      requireSuperAdmin(ctx.actor);
      const key = templateKey(rawKey);
      const next: EmailTemplateText = pickText(input);
      const issues = placeholderIssues(key, next);
      if (issues.length > 0) throw errors.validation(issues);
      return saveText(ctx, key, input.expectedUpdatedAt, next);
    },

    async reset(ctx, rawKey, input) {
      requireSuperAdmin(ctx.actor);
      const key = templateKey(rawKey);
      return saveText(ctx, key, input.expectedUpdatedAt, builtInText(key));
    },

    async preview(ctx, rawKey, input) {
      requireSuperAdmin(ctx.actor);
      const key = templateKey(rawKey);
      // Sample dates in the business time zone, and the configured SOC phone (both cached).
      const [calendar, form] = await Promise.all([
        ticketConfig.getCalendar().catch(() => null),
        ticketConfig.getFormConfig().catch(() => null),
      ]);
      const rendered = await renderEmailTemplatePreview({
        key,
        locale: input.locale,
        subject: input.subject,
        body: input.body,
        appUrl: config.appUrl,
        ...(calendar ? { timeZone: calendar.timeZone } : {}),
        ...(form?.socPhone ? { socPhone: form.socPhone } : {}),
      });
      return { subject: rendered.subject, html: rendered.html, text: rendered.text };
    },
  };
}
