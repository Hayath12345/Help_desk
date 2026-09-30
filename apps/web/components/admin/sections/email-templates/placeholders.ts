// Placeholder checks of the email-template editor (E14), mirroring @loons/emails
// `templatePlaceholderProblems` (the API refuses the same text with 400): `{{name}}` must be one of
// the template's variables (or its legacy names), block (multi-line) variables may only appear in
// the body, and brace text that isn't a placeholder (`{{ticket-number}}`, `{{name}`) is refused —
// it would be sent as typed. The web app can't import @loons/emails, so the variables come from the
// template DTO.

/** `{{name}}`, `{{ name }}` — the same pattern the email renderer substitutes. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/** Distinct placeholder names in `text`, in order of first appearance. */
export function placeholderNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

/**
 * A placeholder with extra braces around it (group 1 / 3), else a `{{` or `}}` that isn't part of
 * one (@loons/emails `malformedPlaceholders`).
 */
const BRACES = new RegExp(`(\\{*)${PLACEHOLDER.source}(\\}*)|\\{\\{|\\}\\}`, 'g');

/**
 * Brace text that looks like a placeholder but isn't one: `{{ticket-number}}`, `{{name}`,
 * `{{name}}}`, `{name}}`… Distinct fragments in order; single braces in prose are fine.
 */
export function malformedPlaceholders(text: string): string[] {
  const fragments = new Set<string>();
  BRACES.lastIndex = 0;
  for (let match = BRACES.exec(text); match; match = BRACES.exec(text)) {
    const [whole] = match;
    if (match[2] !== undefined) {
      if (match[1] || match[3]) fragments.add(whole);
    } else if (whole === '{{') {
      const rest = text.slice(match.index);
      // Up to the first closing brace on the line (or the end of the word when there is none).
      const fragment = /^\{\{[^{}\n]{0,40}?\}\}?/.exec(rest)?.[0] ?? /^\{\{[^\s{}]*/.exec(rest)![0];
      fragments.add(fragment);
      BRACES.lastIndex = match.index + fragment.length;
    } else {
      const before = /\{?[^\s{}]{0,40}$/.exec(text.slice(0, match.index))?.[0] ?? '';
      fragments.add(`${before}${whole}`);
    }
  }
  return [...fragments];
}

export interface PlaceholderRules {
  variables: readonly string[];
  blockVariables: readonly string[];
  /** Pre-rename names the sender still fills: accepted, not offered. */
  legacyVariables?: readonly string[];
}

export interface PlaceholderProblems {
  /** Names the template doesn't provide. */
  unknown: string[];
  /** Block variables used in a subject. */
  blockInSubject: string[];
  /** Brace text that isn't a placeholder, as typed. */
  malformed: string[];
}

/** What is wrong with the placeholders of one field (`subject` or `body`). */
export function placeholderProblems(
  text: string,
  field: 'subject' | 'body',
  rules: PlaceholderRules,
): PlaceholderProblems {
  const allowed = new Set([...rules.variables, ...(rules.legacyVariables ?? [])]);
  const blocks = new Set(rules.blockVariables);
  const unknown: string[] = [];
  const blockInSubject: string[] = [];
  for (const name of placeholderNames(text)) {
    if (!allowed.has(name)) unknown.push(name);
    else if (field === 'subject' && blocks.has(name)) blockInSubject.push(name);
  }
  return { unknown, blockInSubject, malformed: malformedPlaceholders(text) };
}

/** Separates a message key from its `{names}` value in form errors: `key|{{a}}, {{b}}`. */
export const MESSAGE_VALUE_SEPARATOR = '|';

/**
 * The form error for one field (a message key with the names attached), or null. Unknown names
 * are reported first, then malformed placeholders.
 */
export function placeholderError(
  text: string,
  field: 'subject' | 'body',
  rules: PlaceholderRules,
): string | null {
  const { unknown, blockInSubject, malformed } = placeholderProblems(text, field, rules);
  const list = (names: string[]) => names.map((name) => `{{${name}}}`).join(', ');
  if (unknown.length > 0) {
    return `validation.unknownVariable${MESSAGE_VALUE_SEPARATOR}${list(unknown)}`;
  }
  if (malformed.length > 0) {
    return `validation.malformedPlaceholder${MESSAGE_VALUE_SEPARATOR}${malformed.join(', ')}`;
  }
  if (blockInSubject.length > 0) {
    return `validation.blockInSubject${MESSAGE_VALUE_SEPARATOR}${list(blockInSubject)}`;
  }
  return null;
}

/**
 * Inserts `snippet` into `value` in place of the selection `[start, end)` (the end when the
 * selection is unknown). Returns the new text and where the caret goes.
 */
export function insertAt(
  value: string,
  snippet: string,
  selection: { start: number; end: number } | null,
): { value: string; caret: number } {
  const start = Math.min(Math.max(selection?.start ?? value.length, 0), value.length);
  const end = Math.min(Math.max(selection?.end ?? start, start), value.length);
  return {
    value: value.slice(0, start) + snippet + value.slice(end),
    caret: start + snippet.length,
  };
}
