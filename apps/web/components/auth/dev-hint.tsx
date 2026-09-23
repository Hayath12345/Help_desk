import { getTranslations } from 'next-intl/server';
import { isDevelopmentBuild } from '@/lib/auth/env';

/** Replaces the design's demo note; rendered only outside production builds. */
export async function DevHint() {
  if (!isDevelopmentBuild()) return null;
  const t = await getTranslations('auth');
  return (
    <p className="max-w-[400px] text-center text-xs leading-normal text-ink-subtle">
      {t('devHint')}
    </p>
  );
}
