import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/lib/session';
import { AdminOverview } from './_components/admin-overview';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin');
  return { title: t('title') };
}

export default async function AdminOverviewPage() {
  const user = await requireUser(['SUPER_ADMIN', 'TEAM_LEAD']);
  return <AdminOverview role={user.role} />;
}
