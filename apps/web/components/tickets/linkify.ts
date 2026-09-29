// Turns URLs in message bodies into safe links. Bodies are rendered as React text (never HTML),
// so this only splits text; a link is produced only for well-formed http(s) URLs.

export type TextPart =
  { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
/** Punctuation that ends a sentence rather than the URL (incl. Arabic comma / question mark). */
const TRAILING_CHARS = '.,;:!?،؛؟\'"”’)]}>';

const count = (text: string, char: string) => text.split(char).length - 1;

function trimUrl(candidate: string): string {
  let url = candidate;
  while (url.length > 0) {
    const last = url[url.length - 1] ?? '';
    if (!TRAILING_CHARS.includes(last)) break;
    // A closing parenthesis that balances one inside the URL belongs to it (Wikipedia-style).
    if (last === ')' && count(url, '(') >= count(url, ')')) break;
    url = url.slice(0, -1);
  }
  return url;
}

function safeHref(text: string): string | null {
  const href = /^www\./i.test(text) ? `https://${text}` : text;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Splits `text` into plain text and link parts, in order. */
export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = trimUrl(match[0]);
    const href = raw ? safeHref(raw) : null;
    if (!href) continue;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
