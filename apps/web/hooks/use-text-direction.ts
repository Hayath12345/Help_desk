'use client';

import { useLocale } from 'next-intl';
import { getDir } from '@/i18n/config';

/**
 * 'ltr' | 'rtl' for the active UI language. Pass it to the direction-aware motion presets
 * (`sheetVariants(dir)`, `messageVariants(dir)`) so horizontal slides mirror in Arabic.
 */
export function useTextDirection(): 'ltr' | 'rtl' {
  return getDir(useLocale());
}
