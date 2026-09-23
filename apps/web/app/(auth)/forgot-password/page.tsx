import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DevHint } from '@/components/auth/dev-hint';
import { ForgotPasswordFlow } from '@/components/auth/forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.forgot');
  return { title: t('metaTitle') };
}

export default function ForgotPasswordPage() {
  return (
    <>
      <ForgotPasswordFlow />
      <DevHint />
    </>
  );
}
