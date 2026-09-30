import { describe, expect, it } from 'vitest';
import {
  customFieldValueOptions,
  CUSTOM_TEXT_MAX,
  buildCustomFieldsSchema,
  validateCustomFields,
  type CustomFieldDef,
} from './custom-fields.ts';

const fields: CustomFieldDef[] = [
  { key: 'text', type: 'TEXT', required: true, options: [] },
  { key: 'num', type: 'NUMBER', required: false, options: [] },
  { key: 'pick', type: 'DROPDOWN', required: false, options: [{ value: 'a' }, { value: 'b' }] },
  {
    key: 'multi',
    type: 'MULTI_SELECT',
    required: false,
    options: [{ value: 'x' }, { value: 'y' }],
  },
  { key: 'date', type: 'DATE', required: false, options: [] },
  { key: 'yes', type: 'YES_NO', required: true, options: [] },
  { key: 'asset', type: 'ASSET_ID', required: false, options: [] },
];
const schema = buildCustomFieldsSchema(fields);
const check = (values: Record<string, unknown>) => validateCustomFields(schema, values);
const issue = (values: Record<string, unknown>, key: string) => {
  const result = check(values);
  if (result.ok) return null;
  return result.issues.find((i) => i.path[1] === key) ?? null;
};
const base = { text: 'hello', yes: false };

describe('custom fields built from the live config', () => {
  it('accepts valid values and normalises them', () => {
    expect(
      check({
        text: '  hi  ',
        num: '-12.5',
        pick: 'b',
        multi: ['y', 'x', 'y'],
        date: '2024-02-29',
        yes: true,
        asset: ' CAM-1 ',
      }),
    ).toEqual({
      ok: true,
      value: {
        text: 'hi',
        num: -12.5,
        pick: 'b',
        multi: ['y', 'x'],
        date: '2024-02-29',
        yes: true,
        asset: 'CAM-1',
      },
    });
  });

  it('drops blank optional values (empty string, null, empty list)', () => {
    expect(check({ ...base, num: '', pick: null, multi: [], asset: '   ' })).toEqual({
      ok: true,
      value: { text: 'hello', yes: false },
    });
  });

  it('required: missing, blank or null → validation.required; false is a valid YES_NO', () => {
    for (const text of [undefined, '', '   ', null]) {
      expect(issue({ text, yes: true }, 'text')?.message, String(text)).toBe('validation.required');
    }
    expect(issue({ text: 'x' }, 'yes')?.message).toBe('validation.required');
    expect(check({ text: 'x', yes: false }).ok).toBe(true);
  });

  it.each([
    ['text', 42, 'validation.invalid'],
    ['text', 'x'.repeat(CUSTOM_TEXT_MAX + 1), 'validation.tooLong'],
    ['num', 'abc', 'validation.invalid'],
    ['num', '1e3', 'validation.invalid'],
    ['num', Number.POSITIVE_INFINITY, 'validation.invalid'],
    ['num', true, 'validation.invalid'],
    ['pick', 'c', 'validation.invalid'],
    ['pick', ['a'], 'validation.invalid'],
    ['multi', 'x', 'validation.invalid'],
    ['multi', ['x', 'z'], 'validation.invalid'],
    ['multi', [1], 'validation.invalid'],
    ['date', '2023-02-29', 'validation.invalid'],
    ['date', '2026-13-01', 'validation.invalid'],
    ['date', '2026-01-01T10:00:00Z', 'validation.invalid'],
    ['yes', 'true', 'validation.invalid'],
    ['asset', { id: 1 }, 'validation.invalid'],
  ])('%s = %j → %s', (key, value, message) => {
    expect(issue({ ...base, [key]: value }, key)?.message).toBe(message);
  });

  it('unknown keys are rejected one by one', () => {
    const result = check({ ...base, other: 1, camera_id: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      {
        location: 'body',
        path: ['customFields', 'other'],
        message: 'validation.invalid',
        code: 'unknown_field',
      },
      {
        location: 'body',
        path: ['customFields', 'camera_id'],
        message: 'validation.invalid',
        code: 'unknown_field',
      },
    ]);
  });

  it('a category without fields accepts only an empty object', () => {
    const empty = buildCustomFieldsSchema([]);
    expect(validateCustomFields(empty, {})).toEqual({ ok: true, value: {} });
    expect(validateCustomFields(empty, { a: 1 }).ok).toBe(false);
  });
});

describe('custom-field value labels on old tickets (E6)', () => {
  const stored = [
    { value: 'red', labelEn: 'Red', labelAr: 'أحمر' },
    { value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false },
  ];

  it('labels dropdown and multi-select values, archived options included', () => {
    expect(customFieldValueOptions('DROPDOWN', stored, 'green')).toEqual([
      { value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false },
    ]);
    expect(customFieldValueOptions('MULTI_SELECT', stored, ['green', 'red'])).toEqual([
      { value: 'green', labelEn: 'Green', labelAr: 'أخضر', isActive: false },
      { value: 'red', labelEn: 'Red', labelAr: 'أحمر', isActive: true },
    ]);
  });

  it('a value no longer configured keeps itself as its label', () => {
    expect(customFieldValueOptions('DROPDOWN', stored, 'blue')).toEqual([
      { value: 'blue', labelEn: 'blue', labelAr: 'blue', isActive: false },
    ]);
    expect(customFieldValueOptions('DROPDOWN', 'not json options', 'x')).toEqual([
      { value: 'x', labelEn: 'x', labelAr: 'x', isActive: false },
    ]);
    expect(customFieldValueOptions('DROPDOWN', stored, undefined)).toEqual([]);
  });

  it('is null for types without options', () => {
    expect(customFieldValueOptions('TEXT', stored, 'red')).toBe(null);
    expect(customFieldValueOptions('ASSET_ID', null, 'CAM-1')).toBe(null);
  });
});
