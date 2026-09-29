// New-ticket form model: values, the zod schema (the contract's createTicketSchema fields plus
// the live config's rules — category/sub-type relation, Security Incident ⇒ security category,
// typed and required custom fields) and the mapping to the POST /tickets body. Pure and tested.

import {
  TICKET_LIMITS,
  createTicketSchema,
  type CreateTicketInput,
  type CustomFieldType,
  type Impact,
  type Priority,
  type TicketFormConfig,
  type TicketType,
} from '@loons/shared';
import { z } from 'zod';

export type FormCategory = TicketFormConfig['categories'][number];
export type FormSubtype = FormCategory['subtypes'][number];
export type FormCustomField = FormCategory['fields'][number];

/** Form value of one custom field (strings for text-like inputs, as typed). */
export type CustomFieldValue = string | string[] | boolean | undefined;

export interface NewTicketFormValues {
  /** Staff only: the client the ticket is raised for ('' until chosen). */
  requesterId: string;
  type: TicketType;
  subject: string;
  categoryId: string;
  subtypeId: string;
  /** A manually chosen priority; '' = automatic (the sub-type's default). */
  priority: Priority | '';
  impact: Impact;
  siteId: string;
  assetId: string;
  description: string;
  /** Keyed by CustomField.key. */
  customFields: Record<string, CustomFieldValue>;
}

/** i18n keys of the form's own rules (`tickets` namespace). */
export const NEW_TICKET_ERRORS = {
  requesterRequired: 'tickets.newTicket.errors.requesterRequired',
  categoryRequired: 'tickets.newTicket.errors.categoryRequired',
  subtypeRequired: 'tickets.newTicket.errors.subtypeRequired',
  subtypeNeedsCategory: 'tickets.newTicket.errors.subtypeNeedsCategory',
  siteRequired: 'tickets.newTicket.errors.siteRequired',
  /** Rendered with `{ field: <label> }`. */
  fieldRequired: 'tickets.newTicket.errors.fieldRequired',
  numberInvalid: 'tickets.newTicket.errors.numberInvalid',
  dateInvalid: 'tickets.newTicket.errors.dateInvalid',
  optionInvalid: 'tickets.newTicket.errors.optionInvalid',
  securityCategory: 'tickets.newTicket.errors.securityCategory',
  tooLong: 'validation.tooLong',
} as const;

/** Custom-field text values (TEXT / ASSET_ID) are capped like the API does. */
export const CUSTOM_TEXT_MAX = 500;

export function emptyNewTicketValues(
  overrides: Partial<NewTicketFormValues> = {},
): NewTicketFormValues {
  return {
    requesterId: '',
    type: 'INCIDENT',
    subject: '',
    categoryId: '',
    subtypeId: '',
    priority: '',
    impact: 'SINGLE_USER',
    siteId: '',
    assetId: '',
    description: '',
    customFields: {},
    ...overrides,
  };
}

export function findCategory(
  config: TicketFormConfig | undefined,
  categoryId: string,
): FormCategory | undefined {
  return config?.categories.find((c) => c.id === categoryId);
}

/** The category SECURITY_INCIDENT tickets are forced into (spec §7), if it is active. */
export function securityCategory(config: TicketFormConfig | undefined): FormCategory | undefined {
  return config?.categories.find((c) => c.key === config.securityCategoryKey);
}

/** Manual priority, else the sub-type's default, else null (nothing chosen yet). */
export function effectivePriority(
  values: Pick<NewTicketFormValues, 'priority' | 'categoryId' | 'subtypeId'>,
  config: TicketFormConfig | undefined,
): Priority | null {
  if (values.priority) return values.priority;
  const subtype = findCategory(config, values.categoryId)?.subtypes.find(
    (s) => s.id === values.subtypeId,
  );
  return subtype?.defaultPriority ?? null;
}

/** An empty form value for a custom field of this type. */
export function emptyCustomFieldValue(type: CustomFieldType): CustomFieldValue {
  if (type === 'MULTI_SELECT') return [];
  if (type === 'YES_NO') return undefined;
  return '';
}

// ───────────── Schema ─────────────

const isIsoDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isNumber = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

/** Zod schema for one custom field's form value. */
export function customFieldSchema(field: FormCustomField): z.ZodType<CustomFieldValue> {
  const E = NEW_TICKET_ERRORS;
  const options = new Set(field.options.map((o) => o.value));
  const required = field.required;

  switch (field.type) {
    case 'TEXT':
    case 'ASSET_ID': {
      const base = z
        .string({ error: E.fieldRequired })
        .trim()
        .max(CUSTOM_TEXT_MAX, { error: E.tooLong });
      return required ? base.min(1, { error: E.fieldRequired }) : base.optional();
    }
    case 'NUMBER':
      return required
        ? z
            .string({ error: E.fieldRequired })
            .trim()
            .min(1, { error: E.fieldRequired })
            .refine(isNumber, { error: E.numberInvalid })
        : z
            .string()
            .trim()
            .refine((v) => v === '' || isNumber(v), { error: E.numberInvalid })
            .optional();
    case 'DATE':
      return required
        ? z
            .string({ error: E.fieldRequired })
            .min(1, { error: E.fieldRequired })
            .refine(isIsoDate, { error: E.dateInvalid })
        : z
            .string()
            .refine((v) => v === '' || isIsoDate(v), { error: E.dateInvalid })
            .optional();
    case 'DROPDOWN':
      return required
        ? z
            .string({ error: E.fieldRequired })
            .min(1, { error: E.fieldRequired })
            .refine((v) => options.has(v), { error: E.optionInvalid })
        : z
            .string()
            .refine((v) => v === '' || options.has(v), { error: E.optionInvalid })
            .optional();
    case 'MULTI_SELECT': {
      const base = z
        .array(z.string(), { error: E.fieldRequired })
        .refine((list) => list.every((v) => options.has(v)), { error: E.optionInvalid });
      return required
        ? z
            .array(z.string(), { error: E.fieldRequired })
            .min(1, { error: E.fieldRequired })
            .refine((list) => list.every((v) => options.has(v)), { error: E.optionInvalid })
        : base.optional();
    }
    case 'YES_NO':
      return required ? z.boolean({ error: E.fieldRequired }) : z.boolean().optional();
  }
}

export interface NewTicketSchemaOptions {
  /** Staff raise tickets for a client: the requester is required. */
  requireRequester: boolean;
  /** Validation depends on the chosen category and type (read from the values being validated). */
  categoryId: string;
  type: TicketType;
  /** Sites of the requester's organisation, when known (the site must be one of them). */
  siteIds?: readonly string[];
}

/**
 * The form schema for the current category/type. Reuses the contract's field schemas (subject,
 * description, type, impact — same limits and i18n keys as the API) and adds the live-config rules.
 */
export function buildNewTicketSchema(
  config: TicketFormConfig,
  options: NewTicketSchemaOptions,
): z.ZodType<NewTicketFormValues, NewTicketFormValues> {
  const E = NEW_TICKET_ERRORS;
  const base = createTicketSchema.shape;
  const secCategory = securityCategory(config);
  const category = findCategory(config, options.categoryId);
  const activeCategoryIds = new Set(config.categories.map((c) => c.id));
  const siteIds = options.siteIds ? new Set(options.siteIds) : null;

  const categoryId =
    options.type === 'SECURITY_INCIDENT' && secCategory
      ? z
          .string()
          .min(1, { error: E.categoryRequired })
          .refine((v) => v === '' || v === secCategory.id, { error: E.securityCategory })
      : z.string().refine((v) => activeCategoryIds.has(v), { error: E.categoryRequired });

  const subtypeId = category
    ? z.string().refine((v) => category.subtypes.some((s) => s.id === v), {
        error: E.subtypeRequired,
      })
    : z.string().refine(() => false, { error: E.subtypeNeedsCategory });

  const siteId = siteIds
    ? z.string().refine((v) => siteIds.has(v), { error: E.siteRequired })
    : z.uuid({ error: E.siteRequired });

  const customFields = z.object(
    Object.fromEntries((category?.fields ?? []).map((f) => [f.key, customFieldSchema(f)])),
  );

  const schema = z.object({
    requesterId: options.requireRequester ? z.uuid({ error: E.requesterRequired }) : z.string(),
    type: base.type,
    subject: base.subject,
    categoryId,
    subtypeId,
    priority: z.union([z.enum(['P1', 'P2', 'P3', 'P4']), z.literal('')]),
    impact: base.impact,
    siteId,
    assetId: z.string().trim().max(TICKET_LIMITS.assetIdMax, { error: E.tooLong }),
    description: base.description,
    customFields,
  });
  return schema as unknown as z.ZodType<NewTicketFormValues, NewTicketFormValues>;
}

// ───────────── Submit ─────────────

/** The custom-field values to send: only the category's fields, typed, empty ones left out. */
export function customFieldsPayload(
  category: FormCategory,
  values: Record<string, CustomFieldValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of category.fields) {
    const raw = values[field.key];
    switch (field.type) {
      case 'TEXT':
      case 'ASSET_ID':
      case 'DROPDOWN':
      case 'DATE': {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value) out[field.key] = value;
        break;
      }
      case 'NUMBER': {
        const value = typeof raw === 'string' ? raw.trim() : '';
        if (value && Number.isFinite(Number(value))) out[field.key] = Number(value);
        break;
      }
      case 'MULTI_SELECT':
        if (Array.isArray(raw) && raw.length) out[field.key] = [...raw];
        break;
      case 'YES_NO':
        if (typeof raw === 'boolean') out[field.key] = raw;
        break;
    }
  }
  return out;
}

/** Builds (and checks against the contract) the POST /tickets body from valid form values. */
export function toCreateTicketInput(
  values: NewTicketFormValues,
  context: { config: TicketFormConfig; isStaff: boolean; attachmentIds: readonly string[] },
): CreateTicketInput {
  const category = findCategory(context.config, values.categoryId);
  const assetId = values.assetId.trim();
  return createTicketSchema.parse({
    type: values.type,
    categoryId: values.categoryId,
    subtypeId: values.subtypeId,
    ...(values.priority ? { priority: values.priority } : {}),
    impact: values.impact,
    siteId: values.siteId,
    ...(assetId ? { assetId } : {}),
    subject: values.subject,
    description: values.description,
    customFields: category ? customFieldsPayload(category, values.customFields) : {},
    attachmentIds: [...context.attachmentIds],
    ...(context.isStaff ? { requesterId: values.requesterId } : {}),
  });
}

/** Number of fields with an error (custom fields count one each), for "N fields need attention". */
export function countFieldErrors(errors: Record<string, unknown>): number {
  let count = 0;
  for (const [key, value] of Object.entries(errors)) {
    if (!value || key === 'root') continue;
    if (key === 'customFields' && typeof value === 'object') {
      count += Object.keys(value as Record<string, unknown>).filter(
        (k) => k !== 'root' && k !== 'message' && k !== 'type' && k !== 'ref',
      ).length;
      continue;
    }
    count += 1;
  }
  return count;
}
