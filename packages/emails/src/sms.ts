// P1 SMS text (spec §9, contract "Teams / SMS"): `LG-n P1 <team> <category> <console link>` in
// the recipient's language. No subject, client or requester names: an SMS shows on a lock screen.
// Names are shortened so the text fits one segment where it can — 160 GSM-7 characters, or 70
// UCS-2 characters once any character is outside GSM-7 (Arabic always is).

import { formatTicketNumber, type Locale, type Priority } from '@loons/shared';
import { localizedName, type LocalizedName } from './format.ts';

// GSM 03.38 basic character set (one septet each) and its extension table (two septets each).
const GSM_BASIC = new Set(
  Array.from(
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ),
);
const GSM_EXTENDED = new Set(Array.from('^{}\\[~]|€\f'));

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export function smsEncoding(text: string): SmsEncoding {
  for (const ch of text) if (!GSM_BASIC.has(ch) && !GSM_EXTENDED.has(ch)) return 'UCS-2';
  return 'GSM-7';
}

/** Length as the network counts it: GSM-7 septets, or UTF-16 code units for UCS-2. */
export function smsLength(text: string): number {
  if (smsEncoding(text) === 'UCS-2') return text.length;
  let septets = 0;
  for (const ch of text) septets += GSM_EXTENDED.has(ch) ? 2 : 1;
  return septets;
}

/** Number of SMS parts (160 / 153 per part for GSM-7, 70 / 67 for UCS-2). */
export function smsSegments(text: string): number {
  const length = smsLength(text);
  const [single, multi] = smsEncoding(text) === 'GSM-7' ? [160, 153] : [70, 67];
  return length <= single ? 1 : Math.ceil(length / multi);
}

/** Typographic characters an English name may carry, mapped to GSM-7 look-alikes. */
const GSM_FRIENDLY: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '›': '>',
  '‹': '<',
  '…': '...',
  '\u00A0': ' ',
};

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_CHARS = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const RLM = '\u200F';

function clean(value: string, locale: Locale): string {
  let text = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (locale === 'en') text = text.replace(/[‘’“”–—›‹…\u00A0]/g, (ch) => GSM_FRIENDLY[ch] ?? ch);
  return text;
}

function cut(value: string, max: number): string {
  return Array.from(value).slice(0, Math.max(0, max)).join('').trimEnd();
}

export interface SmsTextInput {
  locale: Locale;
  /** 4821 or "LG-4821". */
  ticketNumber: number | string;
  priority: Priority;
  teamName: LocalizedName;
  categoryName: LocalizedName;
  /** Console link to the ticket (`/console/inbox?ticket=LG-n`); never an acknowledge URL. */
  url: string;
}

/** Shortest a name is cut to when making room for one segment. */
const MIN_NAME_CHARS = 6;
/** Longest a team / category name is shown. */
const MAX_NAME_CHARS = 40;

/**
 * "LG-4821 P1 SOC Cybersecurity / SOC https://…/console/inbox?ticket=LG-4821". Arabic texts start
 * with a right-to-left mark so phones lay them out right-to-left. Names are capped at 40
 * characters, and cut further (never below 6) when that makes the text fit one segment; the
 * ticket number, priority and link are never cut. Throws when `url` is not absolute http(s).
 */
export function buildSmsText(input: SmsTextInput): string {
  let url: string;
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    url = parsed.toString();
  } catch {
    throw new Error('SMS text: url must be an absolute http(s) URL');
  }
  const number =
    typeof input.ticketNumber === 'number'
      ? formatTicketNumber(input.ticketNumber)
      : clean(input.ticketNumber, 'en');
  let team = cut(clean(localizedName(input.teamName, input.locale), input.locale), MAX_NAME_CHARS);
  let category = cut(
    clean(localizedName(input.categoryName, input.locale), input.locale),
    MAX_NAME_CHARS,
  );

  const compose = (teamPart: string, categoryPart: string) => {
    const text = [number, input.priority, teamPart, categoryPart, url].filter(Boolean).join(' ');
    return input.locale === 'ar' && /\p{Script=Arabic}/u.test(text) ? `${RLM}${text}` : text;
  };

  let text = compose(team, category);
  if (smsSegments(text) === 1) return text;
  // Only shorten when that can reach one segment: an Arabic (UCS-2, 70 characters) text with a
  // real link rarely can, and names cut to a few letters help nobody. Then it stays two parts.
  if (smsSegments(compose(cut(team, MIN_NAME_CHARS), cut(category, MIN_NAME_CHARS))) > 1) {
    return text;
  }
  // Shorten the longer name first, one character at a time, until the text fits one segment.
  while (smsSegments(text) > 1) {
    const teamChars = Array.from(team).length;
    const categoryChars = Array.from(category).length;
    if (teamChars <= MIN_NAME_CHARS && categoryChars <= MIN_NAME_CHARS) break;
    if (categoryChars >= teamChars) category = cut(category, categoryChars - 1);
    else team = cut(team, teamChars - 1);
    text = compose(team, category);
  }
  return text;
}
