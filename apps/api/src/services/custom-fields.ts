import { z } from 'zod';
import { stripControlChars, toWellFormed, type CustomFieldType } from '@loons/shared';
import type { ValidationIssue } from '../lib/errors.ts';

// Request-time validation of ticket custom fields, built from the live form configuration
// (spec §7: "build the Zod schema at request time from DB config"). Values are keyed by
// CustomField.key; only fields linked to the ticket's category are accepted.

/** Longest accepted TEXT / ASSET_ID value. */
export const CUSTOM_TEXT_MAX = 500;

export interface CustomFieldDef {
  key: string;
  type: CustomFieldType;
  required: boolean;
  options: ReadonlyArray<{ value: string }>;
}

const REQUIRED = 'validation.required';
const INVALID = 'validation.invalid';
const TOO_LONG = 'validation.tooLong';

/** Missing (undefined) → "required"; anything else the field's type rejects → "invalid". */
const typeError = (iss: { input?: unknown }) => (iss.input === undefined ? REQUIRED : INVALID);

/**
 * Blank values count as "not provided" (so optional fields may be cleared). Strings lose control
 * characters and lone surrogates first, like every other free-text field: the values are stored
 * as jsonb, which can hold neither (review SEC-API-2, RR-SEC-3).
 */
function blankToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = toWellFormed(stripControlChars(value)).trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

function valueSchema(field: CustomFieldDef): z.ZodType {
  const allowed = new Set(field.options.map((o) => o.value));
  switch (field.type) {
    case 'TEXT':
    case 'ASSET_ID':
      return z.string({ error: typeError }).max(CUSTOM_TEXT_MAX, { error: TOO_LONG });
    case 'NUMBER':
      // Form inputs may send numbers as strings; either way the value must be a finite number.
      return z.preprocess(
        (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v),
        z.number({ error: typeError }),
      );
    case 'DROPDOWN':
      return z
        .string({ error: typeError })
        .refine((v) => allowed.has(v), { error: INVALID, abort: true });
    case 'MULTI_SELECT':
      return z
        .array(
          z.string({ error: INVALID }).refine((v) => allowed.has(v), { error: INVALID }),
          { error: typeError },
        )
        .transform((values) => [...new Set(values)]);
    case 'DATE':
      return z.iso.date({ error: typeError });
    case 'YES_NO':
      return z.boolean({ error: typeError });
  }
}

/** The zod schema of a category's `customFields` object (unknown keys rejected). */
export function buildCustomFieldsSchema(fields: readonly CustomFieldDef[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const inner = valueSchema(field);
    shape[field.key] = z.preprocess(blankToUndefined, field.required ? inner : inner.optional());
  }
  return z.strictObject(shape, { error: INVALID });
}

export type CustomFieldsSchema = ReturnType<typeof buildCustomFieldsSchema>;

/**
 * Validates `values` against the schema. Returns the normalised values (blank optional fields
 * dropped, strings trimmed, numbers parsed) or the issues, with paths under `customFields`.
 */
export function validateCustomFields(
  schema: CustomFieldsSchema,
  values: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] } {
  const result = schema.safeParse(values);
  if (result.success) {
    const value = Object.fromEntries(
      Object.entries(result.data as Record<string, unknown>).filter(([, v]) => v !== undefined),
    );
    return { ok: true, value };
  }
  const issues: ValidationIssue[] = [];
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({
          location: 'body',
          path: ['customFields', key],
          message: INVALID,
          code: 'unknown_field',
        });
      }
      continue;
    }
    issues.push({
      location: 'body',
      path: ['customFields', ...issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))],
      message: issue.message,
      code: issue.code,
    });
  }
  return { ok: false, issues };
}
