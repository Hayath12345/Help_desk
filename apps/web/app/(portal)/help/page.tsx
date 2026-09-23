import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HelpCenter, type HelpArticle } from './_components/help-center';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.help');
  return { title: t('title') };
}

export default function HelpPage() {
  // Articles are authored in Admin → Help center (Phase 4) and served by the API from Phase 5.
  const articles: HelpArticle[] = [];
  return <HelpCenter articles={articles} />;
}
