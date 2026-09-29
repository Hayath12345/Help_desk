'use client';

import {
  clientCanSetStatus,
  isActiveStatus,
  type TicketStatus,
  type TicketSummaryDto,
} from '@loons/shared';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { StatusPill } from '@/components/common/status-pill';
import { TicketId } from '@/components/common/ticket-id';
import { Button } from '@/components/ui/button';
import { getDir } from '@/i18n/config';
import { formatDateTime, isolate } from '@/lib/format';
import { localizedLabel, placeName, teamName } from '@/lib/tickets/labels';
import { useUpdateTicket } from '@/lib/tickets/mutations';

/** The status a client's resolve button sets (active → solved, solved → reopen), if any. */
export function resolveTarget(status: TicketStatus): 'SOLVED' | 'OPEN' | null {
  const target = status === 'SOLVED' ? 'OPEN' : isActiveStatus(status) ? 'SOLVED' : null;
  return target && clientCanSetStatus(status, target) ? target : null;
}

/**
 * "Mark as solved" / "Reopen ticket" (design 648). Optimistic: the status pill, this label, the
 * composer hint and the My tickets rows change at once; a failed save rolls back with a toast.
 * The button keeps focus while its label flips, and clicks during a save are ignored.
 */
export function ResolveButton({ ticket }: { ticket: Pick<TicketSummaryDto, 'id' | 'status'> }) {
  const t = useTranslations('portal.ticket');
  const update = useUpdateTicket();
  const target = resolveTarget(ticket.status);
  if (!target) return null;

  const onClick = () => {
    if (update.isPending) return;
    update.mutate(
      { ticketId: ticket.id, patch: { status: target } },
      {
        onSuccess: () => {
          toast.success(t(target === 'OPEN' ? 'reopenedToast' : 'solvedToast'));
        },
      },
    );
  };

  return (
    <Button type="button" variant="outline" onClick={onClick} className="h-auto py-2">
      {t(target === 'OPEN' ? 'reopen' : 'markSolved')}
    </Button>
  );
}

/**
 * Thread page header (design 639–649): `LG-n · Category › Sub-type · Site` mono line, subject +
 * status pill (its colour transitions on change), "Handled by <assignee> (<team>) · Opened
 * <date>" (Arabic: "يتولاها <assignee> · <team>", as Arabic team names already end in "(SOC)"),
 * and the resolve button at inline-end.
 *
 * Bidi: config labels (category, sub-type, site) are shown in the UI language, so they are
 * isolated with the page's direction, not `auto` — an Arabic site name that starts with a Latin
 * word ("QNB – المقر الرئيسي") must keep its order. The subject is typed by people in either
 * language, so it keeps `auto`. Names inside sentences are FSI…PDI isolated.
 */
export function TicketHeader({ ticket }: { ticket: TicketSummaryDto }) {
  const t = useTranslations('portal.ticket');
  const locale = useLocale();
  const dir = getDir(locale);
  const category = localizedLabel(ticket.category, locale);
  const path = ticket.subtype
    ? `${category} › ${localizedLabel(ticket.subtype, locale)}`
    : category;
  const site = ticket.site ? placeName(ticket.site, locale) : null;
  const team = isolate(teamName(ticket.team, locale));
  const handledBy = ticket.assignee
    ? t('handledBy', { assignee: isolate(ticket.assignee.name), team })
    : t('handledByTeam', { team });

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      {/* Basis 20rem: on phones the resolve button wraps under the header instead of squeezing it. */}
      <div className="flex min-w-0 grow basis-80 flex-col gap-1.5">
        <p className="text-xs text-ink-muted">
          <TicketId number={ticket.number} />
          <span className="font-mono rtl:font-sans">
            {' · '}
            <bdi dir={dir}>{path}</bdi>
            {site ? (
              <>
                {' · '}
                <bdi dir={dir}>{site}</bdi>
              </>
            ) : null}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="text-[22px] leading-snug font-semibold text-ink [overflow-wrap:anywhere]">
            <bdi>{ticket.subject}</bdi>
          </h1>
          <StatusPill status={ticket.status} />
        </div>
        <p className="text-[13px] text-ink-muted">
          {handledBy}
          {' · '}
          <span suppressHydrationWarning>
            {t('opened', { date: formatDateTime(ticket.createdAt, locale) })}
          </span>
        </p>
      </div>
      <ResolveButton ticket={ticket} />
    </div>
  );
}
