import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ADMIN_SECTION_COMPONENTS } from '@/components/admin/sections/registry';
import { canOpenAdminSection, isAdminSection } from '@/lib/admin/sections';
import { requireUser } from '@/lib/session';

interface SectionPageProps {
  params: Promise<{ section: string }>;
}

export async function generateMetadata({ params }: SectionPageProps): Promise<Metadata> {
  const { section } = await params;
  if (!isAdminSection(section)) return {};
  const t = await getTranslations('admin');
  return { title: t(`sections.${section}.title`) };
}

/**
 * One of the thirteen admin sections: renders `components/admin/sections/<slug>/index.tsx`
 * (docs/PHASE4_CONTRACT.md E1, E8).
 */
export default async function AdminSectionPage({ params }: SectionPageProps) {
  const user = await requireUser(['SUPER_ADMIN', 'TEAM_LEAD']);
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  // Team leads may only open Teams and Macros (the API enforces this, and their team scope, for
  // every admin call).
  if (!canOpenAdminSection(user.role, section)) redirect('/admin');

  const Section = ADMIN_SECTION_COMPONENTS[section];
  return <Section role={user.role} userId={user.id} />;
}
