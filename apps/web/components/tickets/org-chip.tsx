'use client';

import type { ContractType } from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { placeName } from '@/lib/tickets/labels';
import { cn } from '@/lib/utils';

const CONTRACT_TONE: Record<ContractType, string> = {
  AMC: 'bg-success-tint text-success',
  BILLABLE: 'bg-surface-sunken text-ink-secondary',
};

/** "AMC" (green) / "Billable" (grey) pill — New ticket header, requester card. */
export function ContractBadge({
  contract,
  className,
}: {
  contract: ContractType;
  className?: string;
}) {
  const t = useTranslations('tickets.contract');
  return (
    <span
      data-contract={contract}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap',
        CONTRACT_TONE[contract],
        className,
      )}
    >
      {t(contract)}
    </span>
  );
}

/** Rounded "Hamad Medical Corporation [AMC]" chip next to the New ticket title. */
export function OrgChip({
  org,
  className,
}: {
  org: { name: string; nameAr: string | null; contractType: ContractType };
  className?: string;
}) {
  const locale = useLocale();
  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-2 rounded-full border border-line py-[3px] ps-3 pe-1 text-[13px] text-ink',
        className,
      )}
    >
      <span className="min-w-0 truncate">{placeName(org, locale)}</span>
      <ContractBadge contract={org.contractType} />
    </span>
  );
}
