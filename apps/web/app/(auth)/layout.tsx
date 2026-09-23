import { Logo } from '@/components/common/logo';
import { LanguageToggle } from '@/components/shell/language-toggle';

/** Centered column on the page background (design login block, lines 456–550). */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-7 bg-page px-5 py-10">
      <div className="absolute top-4 inset-e-5">
        <LanguageToggle />
      </div>
      <Logo size="lg" className="font-semibold whitespace-nowrap text-ink" />
      {children}
    </main>
  );
}
