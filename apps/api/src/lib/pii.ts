// Helpers that keep personal data out of logs and dead-letter records.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// International phone numbers (E.164-ish): a + followed by 8–15 digits, optional separators.
const PHONE = /\+\d[\d\s().-]{7,18}\d/g;

/** Replaces email addresses and phone numbers in free text (e.g. provider error messages). */
export function redactPii(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

/** "+97455501234" → "+974******34". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= 6) return '***';
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(3, digits.length - 6))}${digits.slice(-2)}`;
}
