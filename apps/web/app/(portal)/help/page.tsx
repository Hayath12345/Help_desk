import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HelpCenter } from './_components/help-center';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.help');
  return { title: t('title') };
}

export default function HelpPage() {
  // The articles are fetched in the browser (GET /help/articles in the UI language) and kept live
  // by `config:updated` (scope `help-center`), like the rest of the portal's data.
  return <HelpCenter />;
}
