import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { AuthCard, AuthCardHeader } from '@/components/auth/auth-card';
import { DevHint } from '@/components/auth/dev-hint';
import { SignupForm } from '@/components/auth/signup-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.signup');
  return { title: t('metaTitle') };
}

export default async function SignupPage() {
  const t = await getTranslations('auth.signup');
  return (
    <>
      <AuthCard aria-labelledby="signup-title" className="gap-4">
        <AuthCardHeader titleId="signup-title" title={t('title')} />
        <SignupForm />
      </AuthCard>
      <DevHint />
    </>
  );
}
