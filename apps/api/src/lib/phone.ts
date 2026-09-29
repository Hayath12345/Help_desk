// Phone numbers for SMS (decision D11): `User.phone` is free text ("+974 5550 1000",
// "00974-5550-1000", "+44 (0)20 7946 0000"); the SMS providers need E.164 ("+97455501000").

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits → ASCII. */
function asciiDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** E.164: "+", a country code that doesn't start with 0, at most 15 digits in all. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * The number in E.164, or null when it isn't an international number. Accepts a leading "+" or
 * the "00" international prefix, spaces, hyphens, dots, slashes, parentheses and a "(0)" trunk
 * prefix after the country code. A local number without a country code is refused (null): the
 * country can't be guessed safely.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = asciiDigits(raw.normalize('NFKC'))
    // Direction marks and other invisible format characters that phones and spreadsheets add.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
  value = value.replace(/\(0\)/g, '').replace(/[\s\-./()]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  return E164.test(value) ? value : null;
}
