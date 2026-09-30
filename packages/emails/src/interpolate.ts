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

/** A template split into its literal text and its `{{variable}}` placeholders, in order. */
export type TemplatePart = { type: 'text'; text: string } | { type: 'variable'; name: string };

export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match.index > last) parts.push({ type: 'text', text: template.slice(last, match.index) });
    parts.push({ type: 'variable', name: match[1] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ type: 'text', text: template.slice(last) });
  return parts;
}

/**
 * The text a placeholder is replaced with: the variable's value as a string, or an empty string
 * when it has none (reported through `onMissing`).
 */
export function variableText(
  vars: TemplateVariables,
  name: string,
  onMissing?: (name: string) => void,
): string {
  const value = lookup(vars, name);
  if (value === undefined || value === null) {
    onMissing?.(name);
    return '';
  }
  return String(value);
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
  return parseTemplate(template)
    .map((part) =>
      esc(part.type === 'text' ? part.text : variableText(vars, part.name, options.onMissing)),
    )
    .join('');
}

/** Distinct placeholder names used in a template, in order of first appearance. */
export function templateVariables(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * A placeholder with extra braces around it (group 1 / 3), else a `{{` or `}}` that isn't part of
 * one. Scanned left to right, so each valid placeholder is consumed whole first.
 */
const BRACES = new RegExp(`(\\{*)${PLACEHOLDER.source}(\\}*)|\\{\\{|\\}\\}`, 'g');

/**
 * Brace text that looks like a placeholder but isn't one, so it would be sent as typed:
 * `{{ticket-number}}`, `{{ticket number}}`, `{{name}` (unclosed), `{{name}}}` / `{{{name}}` (extra
 * braces), `{name}}`. Distinct fragments in order of first appearance; single braces in prose
 * (`{x}`) are fine.
 */
export function malformedPlaceholders(template: string): string[] {
  const fragments = new Set<string>();
  BRACES.lastIndex = 0;
  for (let match = BRACES.exec(template); match; match = BRACES.exec(template)) {
    const [whole] = match;
    if (match[2] !== undefined) {
      // A valid name: malformed only with extra braces around it.
      if (match[1] || match[3]) fragments.add(whole);
    } else if (whole === '{{') {
      // Up to the first closing brace on the line (or the end of the word when there is none).
      const rest = template.slice(match.index);
      const fragment = /^\{\{[^{}\n]{0,40}?\}\}?/.exec(rest)?.[0] ?? /^\{\{[^\s{}]*/.exec(rest)![0];
      fragments.add(fragment);
      BRACES.lastIndex = match.index + fragment.length;
    } else {
      // `}}` with no opening pair: include the word it closes.
      const before = /\{?[^\s{}]{0,40}$/.exec(template.slice(0, match.index))?.[0] ?? '';
      fragments.add(`${before}${whole}`);
    }
  }
  return [...fragments];
}
