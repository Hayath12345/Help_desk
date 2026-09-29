// Block variables: multi-line values written by people (a ticket description, a reply) or built
// by the app (the digest's ticket list). When the placeholder is a whole paragraph of the
// template, the value keeps its own paragraphs and line breaks; anywhere else it is collapsed onto
// one line like every other value. Block values are never linkified and are escaped like any other
// text (React escapes every text node). Long values are cut at BLOCK_MAX_CHARS, and the email then
// says where the full text can be read.

export const BLOCK_VARIABLES = ['description', 'messageBody', 'ticketList'] as const;
export type BlockVariable = (typeof BLOCK_VARIABLES)[number];
const BLOCK_VARIABLE_NAMES: ReadonlySet<string> = new Set(BLOCK_VARIABLES);

export function isBlockVariable(name: string): name is BlockVariable {
  return BLOCK_VARIABLE_NAMES.has(name);
}

/** Longest block value shown, in characters (Unicode code points), including the "…". */
export const BLOCK_MAX_CHARS = 2000;

const ELLIPSIS = '…';

/**
 * Control characters other than tab and line feed, plus the Unicode line / paragraph separators
 * (turned into line feeds first).
 */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Bidi embedding / override / isolate controls (U+202A–U+202E, U+2066–U+2069). Client text must
 * not reorder what follows it in a subject or a paragraph (an override shows the rest of the line
 * backwards, organisation name included); the email layout sets the direction itself. Same set
 * as the Teams card strips.
 */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/**
 * CRLF / CR / U+2028 → LF, U+2029 → blank line, other control characters and bidi controls
 * removed.
 */
export function normalizeBlockText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n\n')
    .replace(CONTROL_CHARS, '')
    .replace(BIDI_CONTROLS, '');
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * Cuts `value` to at most `max` characters (code points, so a surrogate pair is never split),
 * ending in "…". When a line break falls in the last fifth of the kept text, the cut is made there
 * so a list or paragraph isn't broken mid-line.
 */
export function truncateBlockText(value: string, max: number = BLOCK_MAX_CHARS): TruncatedText {
  const text = normalizeBlockText(value).trim();
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  let kept = chars.slice(0, Math.max(0, max - ELLIPSIS.length)).join('');
  const lastBreak = kept.lastIndexOf('\n');
  if (lastBreak > 0 && lastBreak >= Math.floor(kept.length * 0.8)) kept = kept.slice(0, lastBreak);
  return { text: `${kept.trimEnd()}${ELLIPSIS}`, truncated: true };
}

/**
 * A block value as paragraphs of lines: blank (whitespace-only) lines separate paragraphs, other
 * line breaks are kept inside a paragraph, trailing spaces are dropped.
 */
export function blockParagraphs(value: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const raw of normalizeBlockText(value).split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() !== '') {
      current.push(line);
    } else if (current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}
