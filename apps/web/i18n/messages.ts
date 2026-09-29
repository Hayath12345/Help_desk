import type { AppLocale } from './config';

/** One JSON file per namespace: messages/<locale>/<namespace>.json */
export const NAMESPACES = [
  'common',
  'auth',
  'validation',
  'errors',
  'portal',
  'tickets',
  'console',
  'admin',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

type Messages = Record<string, unknown>;

async function loadLocale(locale: AppLocale): Promise<Messages> {
  const entries = await Promise.all(
    NAMESPACES.map(
      async (ns) =>
        [ns, (await import(`../messages/${locale}/${ns}.json`)).default as Messages] as const,
    ),
  );
  return Object.fromEntries(entries);
}

function isRecord(v: unknown): v is Messages {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Arabic strings override English ones; any key missing (or empty) in Arabic falls back to English. */
function mergeWithFallback(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (isRecord(current) && isRecord(value)) out[key] = mergeWithFallback(current, value);
    else if (value !== '' && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export async function loadMessages(locale: AppLocale): Promise<Messages> {
  const en = await loadLocale('en');
  if (locale === 'en') return en;
  return mergeWithFallback(en, await loadLocale(locale));
}
