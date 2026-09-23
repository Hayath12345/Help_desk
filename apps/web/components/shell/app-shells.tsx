import { useTranslations } from 'next-intl';
import { AdminNav } from './admin-nav';
import { ConsoleSearchProvider } from './console-search';
import { ConsoleTopBar } from './console-top-bar';
import { SkipLink } from './nav-link';
import { PortalTopBar } from './portal-top-bar';
import type { ShellUser } from './types';

// Page chrome for the three signed-in areas. The route-group layouts authenticate with
// requireUser() and hand the user to these; they contain no data fetching of their own.

/** Client portal (design 552–576): top bar + centred 960px column, 32px 24px padding, 20px gap. */
export function PortalShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const t = useTranslations('common');
  return (
    <div className="flex min-h-dvh flex-col bg-page">
      <SkipLink label={t('skipToContent')} />
      <PortalTopBar user={user} />
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-[960px] flex-1 flex-col gap-5 px-4 py-8 outline-none sm:px-6"
      >
        {children}
      </main>
    </div>
  );
}

/** Agent console (design 674–705): sticky top bar over a full-height white body. */
export function ConsoleShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const t = useTranslations('common');
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <SkipLink label={t('skipToContent')} />
      <ConsoleSearchProvider>
        <ConsoleTopBar user={user} />
        <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {children}
        </main>
      </ConsoleSearchProvider>
    </div>
  );
}

/**
 * Admin panel: the console top bar plus a two-column body with the section nav at inline-start
 * (same language as the console's Views column); stacks on small screens.
 */
export function AdminShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const t = useTranslations('common');
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <SkipLink label={t('skipToContent')} />
      <ConsoleTopBar area="admin" user={user} />
      <div className="flex flex-1 flex-col md:grid md:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-page px-3 py-3 md:border-e md:border-b-0 md:py-5">
          <div className="md:sticky md:top-20">
            <AdminNav role={user.role} />
          </div>
        </aside>
        <main
          id="main"
          tabIndex={-1}
          className="flex min-w-0 flex-col gap-[22px] bg-surface-muted px-4 py-8 outline-none sm:px-9"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
