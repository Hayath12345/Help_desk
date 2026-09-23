// `{{variable}}` substitution for admin-editable email templates (subject / body text).
// The HTML layout lives in code; only plain text with placeholders is stored in the database.

export type TemplateValue = string | number | boolean | null | undefined;
export type TemplateVariables = Readonly<Record<string, TemplateValue>>;

/** `{{name}}`, `{{ name }}`, `{{ticket.number}}` — letters, digits, `_` and `.`. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export interface InterpolateOptions {
  /**
   * Escape the output for use as HTML text: both the literal template text and every
   * substituted value are escaped, so the result can be inserted into markup safely.
   */
  escapeHtml?: boolean;
  /** Called for each placeholder that has no value (it is replaced with an empty string). */
  onMissing?: (name: string) => void;
}

function lookup(vars: TemplateVariables, name: string): TemplateValue {
  // Own properties only: `{{constructor}}` or `{{__proto__}}` must never reach Object.prototype.
  return Object.hasOwn(vars, name) ? vars[name] : undefined;
}

/**
 * Replaces `{{variable}}` placeholders with values from `vars`.
 * Unknown placeholders become empty strings (and are reported through `onMissing`).
 */
export function interpolate(
  template: string,
  vars: TemplateVariables = {},
  options: InterpolateOptions = {},
): string {
  const esc = options.escapeHtml ? escapeHtml : (s: string) => s;
  let out = '';
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index;
    const name = match[1] ?? '';
    out += esc(template.slice(last, index));
    const value = lookup(vars, name);
    if (value === undefined || value === null) options.onMissing?.(name);
    out += esc(value === undefined || value === null ? '' : String(value));
    last = index + match[0].length;
  }
  out += esc(template.slice(last));
  return out;
}

/** Distinct placeholder names used in a template, in order of first appearance. */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}
