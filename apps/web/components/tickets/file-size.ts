'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { intlLocale } from '@/lib/format';

const MB = 1024 * 1024;

/** 1_250_000 → { size: 1.2, unit: 'MB' }; 3_000 → { size: 3, unit: 'KB' } (design `fsize`). */
export function fileSizeParts(bytes: number): { size: number; unit: 'KB' | 'MB' } {
  if (bytes > MB) return { size: Math.round((bytes / MB) * 10) / 10, unit: 'MB' };
  return { size: Math.max(1, Math.round(bytes / 1024)), unit: 'KB' };
}

/** "1.2 MB" / "340 KB" in the UI language, Latin digits. */
export function useFileSizeFormatter(): (bytes: number) => string {
  const t = useTranslations('tickets.attachments');
  const locale = useLocale();
  return useCallback(
    (bytes: number) => {
      const { size, unit } = fileSizeParts(bytes);
      const formatted = new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 1,
      }).format(size);
      return unit === 'MB' ? t('sizeMb', { size: formatted }) : t('sizeKb', { size: formatted });
    },
    [t, locale],
  );
}
