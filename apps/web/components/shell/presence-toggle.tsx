'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useLocalStorageState } from '@/hooks/use-local-storage-state';
import { cn } from '@/lib/utils';

type Presence = 'online' | 'away';

const PRESENCE_KEY = 'loons.console.presence';
const isPresence = (value: string): value is Presence => value === 'online' || value === 'away';

/**
 * Online / Away pill (design 692). Phase 1 persists the choice in this browser only; the server
 * side of agent availability arrives with assignment rules.
 *
 * A switch named "Online" (constant, as the switch pattern requires): Away is announced as
 * "Online, off" rather than the contradictory "Away, off". The visible text shows the state.
 */
export function PresenceToggle({ className }: { className?: string }) {
  const t = useTranslations('console.presence');
  const [presence, setPresence] = useLocalStorageState<Presence>(PRESENCE_KEY, 'online', isPresence);
  const online = presence === 'online';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={online}
      aria-label={t('online')}
      onClick={() => {
        const next: Presence = online ? 'away' : 'online';
        setPresence(next);
        toast(next === 'online' ? t('nowOnline') : t('nowAway'));
      }}
      className={cn(
        'inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-[5px] text-sm font-medium whitespace-nowrap transition-colors duration-200 ease-out',
        online ? 'bg-success-tint text-success' : 'bg-surface-sunken text-ink-muted-on-sunken',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-[7px] rounded-full transition-colors duration-200 ease-out',
          online ? 'bg-success-strong' : 'bg-ink-subtle',
        )}
      />
      <span className="max-sm:sr-only">{online ? t('online') : t('away')}</span>
    </button>
  );
}
