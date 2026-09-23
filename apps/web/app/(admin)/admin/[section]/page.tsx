import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canOpenAdminSection, isAdminSection } from '@/components/shell/admin-sections';
import { requireUser } from '@/lib/session';
import { AdminSectionPlaceholder } from '../_components/admin-section-placeholder';

interface SectionPageProps {
  params: Promise<{ section: string }>;
}

export async function generateMetadata({ params }: SectionPageProps): Promise<Metadata> {
  const { section } = await params;
  if (!isAdminSection(section)) return {};
  const t = await getTranslations('admin');
  return { title: t(`sections.${section}.title`) };
}

/** One of the eleven admin sections (Phase 1: header + placeholder; editors arrive in Phase 4). */
export default async function AdminSectionPage({ params }: SectionPageProps) {
  const user = await requireUser(['SUPER_ADMIN', 'TEAM_LEAD']);
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  // Team leads may only open Teams and Macros (the API enforces this for every admin call).
  if (!canOpenAdminSection(user.role, section)) redirect('/admin');

  return <AdminSectionPlaceholder section={section} />;
}
