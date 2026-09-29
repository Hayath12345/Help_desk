// Helpers that keep personal data and secrets out of logs and dead-letter records.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// International phone numbers: a + (or the 00 international prefix) followed by 8–15 digits,
// optional separators.
const PHONE = /(?:\+|\b00(?=[1-9]))\d[\d\s().-]{7,18}\d/g;
// Absolute URLs: a webhook URL carries its secret in the path / query (Teams, Power Automate).
const URL_WITH_PATH = /\b(https?:\/\/[^\s/?#"'<>]+)[/?#][^\s"'<>]*/gi;

/**
 * Replaces email addresses, phone numbers and the path / query of URLs (webhook secrets) in free
 * text, e.g. provider error messages. A URL keeps its scheme and host only.
 */
export function redactPii(text: string): string {
  return text
    .replace(URL_WITH_PATH, '$1/[redacted]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]');
}

/** "+97455501234" → "+974******34". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(3, digits.length - 6))}${digits.slice(-2)}`;
}

/** The host of a URL (what a Teams delivery records instead of the secret webhook URL). */
export function urlHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return 'invalid-url';
  }
}
