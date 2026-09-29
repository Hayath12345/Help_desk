// Localised labels of config records and references. Config labels are stored in both languages;
// an empty Arabic label falls back to English (spec §11).

import type { Locale } from '@loons/shared';
import { isolateDirection } from '@/lib/format';

export interface LabelPair {
  labelEn: string;
  labelAr: string;
}

const pick = (locale: Locale, en: string, ar: string | null | undefined) =>
  locale === 'ar' && ar && ar.trim() !== '' ? ar : en;

/** Category, sub-type, custom field or option label. */
export function localizedLabel(item: LabelPair, locale: Locale): string {
  return pick(locale, item.labelEn, item.labelAr);
}

export function teamName(team: { nameEn: string; nameAr: string }, locale: Locale): string {
  return pick(locale, team.nameEn, team.nameAr);
}

/** Organisation or site name (`nameAr` is optional). */
export function placeName(place: { name: string; nameAr: string | null }, locale: Locale): string {
  return pick(locale, place.name, place.nameAr);
}

/** Custom-field placeholder in the UI language (falls back to English, then nothing). */
export function fieldPlaceholder(
  field: { placeholderEn: string | null; placeholderAr: string | null },
  locale: Locale,
): string | undefined {
  return pick(locale, field.placeholderEn ?? '', field.placeholderAr) || undefined;
}

const EXAMPLE_PREFIX = /^(?:e\.\s?g\.?|eg\.?|example:?)\s*/i;
const OPTIONAL = /^\(?optional\)?$/i;
const ARABIC = /[؀-ۿ]/;

/** Whether text contains Arabic letters (e.g. a placeholder translated into, or stored in, Arabic). */
export function hasArabic(text: string): boolean {
  return ARABIC.test(text);
}

/** How the UI language says the words around an asset placeholder. */
export interface AssetPlaceholderWords {
  /** "e.g. {example}" in the UI language. */
  example: (example: string) => string;
  /** "Optional" in the UI language. */
  optional: string;
}

/**
 * A category's "Asset / device ID" placeholder in the UI language. Categories store it once, in
 * English ("e.g. FW-01", "Optional"; an Arabic column is a Phase 4 contract change): in Arabic
 * the words around the example ID are translated and the ID is kept as configured, in a
 * left-to-right isolate (LRI … PDI): an ID that starts with digits ("2026-018") would otherwise
 * be read as Arabic numbers and shown as "018-2026" (UI-RR-2). Text that isn't one of those
 * shapes (or is already Arabic) is shown as configured (spec §11 fallback).
 */
export function localizedAssetPlaceholder(
  placeholder: string | null | undefined,
  locale: Locale,
  words: AssetPlaceholderWords,
): string | undefined {
  const text = placeholder?.trim();
  if (!text) return undefined;
  if (locale !== 'ar' || ARABIC.test(text)) return text;
  if (OPTIONAL.test(text)) return words.optional;
  const prefix = EXAMPLE_PREFIX.exec(text);
  const example = prefix ? text.slice(prefix[0].length).trim() : '';
  return example ? words.example(isolateDirection(example, 'ltr')) : text;
}
