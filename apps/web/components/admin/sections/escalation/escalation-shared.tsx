'use client';

// Labels shared by the escalation table and sheet: the target ("On-call user", "Team leads", a
// person), the delay ("At once", "After 15 min") and the warnings a rule carries.

import type { EscalationRuleAdminDto, EscalationWarning } from '@loons/shared';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { useSlaWindowFormatter } from '@/lib/tickets/i18n';
import { cn } from '@/lib/utils';

export const ESCALATION_CHANNEL_ORDER = ['EMAIL', 'SMS', 'TEAMS'] as const;

/** "On-call user" / "Team leads" / "Super admins" / the person's name. */
export function useTargetLabel(): (
  rule: Pick<EscalationRuleAdminDto, 'targetType' | 'targetRole' | 'targetUser'>,
) => string {
  const t = useTranslations('admin-sla.escalation');
  return useCallback(
    (rule) => {
      if (rule.targetType === 'ON_CALL') return t('targets.ON_CALL');
      if (rule.targetType === 'ROLE') {
        return rule.targetRole === 'SUPER_ADMIN' ? t('roles.SUPER_ADMIN') : t('roles.TEAM_LEAD');
      }
      if (!rule.targetUser) return t('targets.userMissing');
      return rule.targetUser.isActive
        ? rule.targetUser.name
        : t('targets.userInactive', { name: rule.targetUser.name });
    },
    [t],
  );
}

/** "At once" for 0, else "After 15 min" / "After 1 hour" (calendar time: the chain never pauses). */
export function useDelayLabel(): (afterMins: number) => string {
  const t = useTranslations('admin-sla.escalation');
  const formatWindow = useSlaWindowFormatter();
  return useCallback(
    (afterMins) =>
      afterMins <= 0
        ? t('delay.atOnce')
        : t('delay.after', { duration: formatWindow(afterMins, false) }),
    [t, formatWindow],
  );
}

/** The warnings of a rule, as sentences (a global rule speaks of "some teams"). */
export function useWarningText(): (warning: EscalationWarning, global: boolean) => string {
  const t = useTranslations('admin-sla.escalation.warnings');
  return useCallback(
    (warning, global) => {
      const scoped = global && (warning === 'teams_no_webhook' || warning.startsWith('on_call'));
      return scoped ? t(`global.${warning as 'teams_no_webhook'}`) : t(warning);
    },
    [t],
  );
}

export function WarningList({
  rule,
  className,
}: {
  rule: Pick<EscalationRuleAdminDto, 'warnings' | 'teamId'>;
  className?: string;
}) {
  const text = useWarningText();
  if (rule.warnings.length === 0) return null;
  return (
    <ul className={cn('flex flex-col gap-1', className)}>
      {rule.warnings.map((w) => (
        <li key={w} className="flex items-start gap-1.5 text-[13px] leading-snug text-note-ink">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{text(w, rule.teamId === null)}</span>
        </li>
      ))}
    </ul>
  );
}
