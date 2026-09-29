'use client';

import type { P1ChainStep, TicketSummaryDto } from '@loons/shared';
import { BellRing, CircleCheck } from 'lucide-react';
import { useLocale, useNow, useTranslations } from 'next-intl';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatDuration, formatNumber, formatTime, isolate } from '@/lib/format';
import { isApiRequestError } from '@/lib/api/errors';
import { useApiErrorText } from '@/lib/tickets/i18n';
import { useAcknowledgeTicket } from '@/lib/tickets/mutations';
import { cn } from '@/lib/utils';

type P1Fields = Pick<
  TicketSummaryDto,
  'id' | 'priority' | 'status' | 'p1Since' | 'p1EscalationStep' | 'p1AckedAt' | 'p1AckedBy'
> & {
  /** The team's P1 chain (ticket detail only; a list row has none). */
  p1Chain?: readonly P1ChainStep[] | null;
};

export type P1BannerModel =
  | {
      kind: 'unacknowledged';
      /**
       * Last escalation step fired (0 = none yet) and time since the ticket became P1 — both
       * null for a P1 without a P1 period (`p1Since` null: tickets from before Phase 3, which
       * no escalation chain runs for, D10).
       */
      step: number | null;
      elapsedMs: number | null;
      /** Steps in the team's chain (null while the detail with the chain isn't loaded). */
      stepCount: number | null;
      /** When the next step fires (epoch ms); null at the end of the chain or without it. */
      nextAt: number | null;
    }
  | { kind: 'acknowledged'; by: string | null; at: string };

/**
 * What the conversation header shows about a P1's acknowledgement (docs/PHASE3_CONTRACT.md → Web,
 * D5/D16): nothing unless the ticket is P1; "Acknowledged by X · time" once acknowledged; the
 * red banner with the Acknowledge button while it isn't — unless it is already solved or closed
 * (nothing escalates then). "Step N of M" and the next step's time come from the team's chain
 * (`p1Chain` on the ticket detail; team rules replace the global chain, D3; each step fires
 * `afterMins` after `p1Since`); a list row alone shows "step N".
 */
export function p1BannerModel(ticket: P1Fields, now: number): P1BannerModel | null {
  if (ticket.priority !== 'P1') return null;
  if (ticket.p1AckedAt) {
    return { kind: 'acknowledged', by: ticket.p1AckedBy?.name ?? null, at: ticket.p1AckedAt };
  }
  if (ticket.status === 'SOLVED' || ticket.status === 'CLOSED') return null;
  const since = ticket.p1Since ? Date.parse(ticket.p1Since) : Number.NaN;
  if (Number.isNaN(since)) {
    return { kind: 'unacknowledged', step: null, elapsedMs: null, stepCount: null, nextAt: null };
  }
  const chain = ticket.p1Chain && ticket.p1Chain.length > 0 ? ticket.p1Chain : null;
  const next = chain?.find((r) => r.step > ticket.p1EscalationStep) ?? null;
  return {
    kind: 'unacknowledged',
    step: ticket.p1EscalationStep,
    elapsedMs: Math.max(0, now - since),
    stepCount: chain ? chain.length : null,
    nextAt: next ? since + next.afterMins * 60_000 : null,
  };
}

/** List rows mark P1 tickets still waiting for an acknowledgement. */
export function isUnacknowledgedP1(ticket: P1Fields): boolean {
  return p1BannerModel(ticket, 0)?.kind === 'unacknowledged';
}

/**
 * P1 banner in the conversation header. Unacknowledged: the design's P1 alert red with a white
 * "Acknowledge" button (same language as the New-ticket P1 banner). The acknowledgement is
 * server-confirmed; afterwards the banner turns into a calm green "Acknowledged by X · time" line,
 * which takes the focus the button had. A failure is shown in the banner (role="alert"). A 409
 * (the ticket stopped being P1 or was closed meanwhile) is also toasted, because the reloaded
 * ticket removes the banner with its message; the focus then goes to `focusFallbackId` (the
 * conversation heading) instead of the page.
 */
export function P1Banner({
  ticket,
  className,
  focusFallbackId,
}: {
  ticket: P1Fields;
  className?: string;
  /** Element to focus when the banner disappears while it holds the focus (after a 409). */
  focusFallbackId?: string;
}) {
  const t = useTranslations('console.p1');
  const locale = useLocale();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const errorText = useApiErrorText();
  const now = useNow({ updateInterval: 15_000 }).getTime();
  const acknowledge = useAcknowledgeTicket();
  const [error, setError] = useState<string | null>(null);
  // Set when the agent presses Acknowledge: the acknowledged line takes the button's focus when it
  // appears (the button is gone then). An acknowledgement pushed by someone else never moves focus.
  const focusOnAcknowledged = useRef(false);
  const acknowledgedRef = useCallback((node: HTMLParagraphElement | null) => {
    if (node && focusOnAcknowledged.current) {
      focusOnAcknowledged.current = false;
      node.focus();
    }
  }, []);
  const model = p1BannerModel(ticket, now);
  // Set on a refused acknowledgement: if the reloaded ticket no longer has a banner, the focus
  // (on the Acknowledge button) would fall to the page.
  const rescueFocus = useRef(false);
  const gone = model === null;
  useLayoutEffect(() => {
    if (!gone || !rescueFocus.current) return;
    rescueFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) {
      if (focusFallbackId) document.getElementById(focusFallbackId)?.focus();
    }
  }, [gone, focusFallbackId]);

  if (!model) return null;

  if (model.kind === 'acknowledged') {
    const time = formatDateTime(model.at, locale);
    return (
      <p
        ref={acknowledgedRef}
        tabIndex={-1}
        data-p1="acknowledged"
        className={cn(
          'flex items-start gap-2 rounded-lg bg-success-tint px-3.5 py-2.5 text-[13px] leading-[1.45] font-medium text-success outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-hidden',
          className,
        )}
      >
        <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
        <span>
          {model.by
            ? t('acknowledged', { name: isolate(model.by), time })
            : t('acknowledgedNoName', { time })}
        </span>
      </p>
    );
  }

  const parts = [t('title')];
  if (model.step !== null) {
    const step = formatNumber(model.step, locale);
    if (model.step === 0) parts.push(t('notEscalated'));
    else if (model.stepCount !== null) {
      parts.push(t('stepOf', { step, count: formatNumber(model.stepCount, locale) }));
    } else parts.push(t('step', { step }));
  }
  if (model.nextAt !== null) {
    parts.push(
      model.nextAt > now
        ? t('nextIn', {
            duration: formatDuration(model.nextAt - now, locale),
            time: formatTime(model.nextAt, locale),
          })
        : t('nextDue'),
    );
  }
  if (model.elapsedMs !== null) {
    parts.push(t('since', { duration: formatDuration(model.elapsedMs, locale) }));
  }

  const onAcknowledge = () => {
    if (acknowledge.isPending) return;
    setError(null);
    focusOnAcknowledged.current = true;
    acknowledge.mutate(ticket.id, {
      onSuccess: (result) => {
        if (result.alreadyAcknowledged) {
          const name = result.ticket.p1AckedBy?.name;
          toast(
            name
              ? t('alreadyAcknowledged', { name: isolate(name) })
              : t('alreadyAcknowledgedNoName'),
          );
        }
      },
      onError: (failure) => {
        focusOnAcknowledged.current = false;
        const message = t('failed', { reason: errorText(failure) });
        setError(message);
        if (isApiRequestError(failure) && failure.status === 409) {
          // The ticket changed (no longer P1, closed): the reload may take the banner away.
          rescueFocus.current = true;
          toast.error(message);
        }
      },
    });
  };

  return (
    <div
      data-p1="unacknowledged"
      className={cn(
        // The border only shows in forced-colors mode, where the red background is dropped.
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-transparent bg-danger-alert px-3.5 py-2.5 text-primary-foreground forced-colors:border-[CanvasText]',
        className,
      )}
    >
      <p className="flex min-w-0 flex-[1_1_240px] items-start gap-2 text-[13px] leading-[1.45] font-medium">
        <BellRing aria-hidden="true" className="mt-px size-4 shrink-0" />
        {/* Each part is isolated in the UI direction, so "P1" and the step's digits of one part
            never pair up with those of the next across the separator in Arabic. */}
        <span>
          <bdi dir={dir}>
            <strong className="font-bold">{parts[0]}</strong>
          </bdi>
          {parts.slice(1).map((part) => (
            <span key={part}>
              {' · '}
              <bdi dir={dir}>{part}</bdi>
            </span>
          ))}
        </span>
      </p>
      <Button
        type="button"
        size="sm"
        onClick={onAcknowledge}
        // aria-disabled (not disabled) while saving, so the focus stays on the button.
        aria-disabled={acknowledge.isPending || undefined}
        className="bg-surface font-bold text-danger-alert-ink hover:bg-danger-tint"
      >
        {acknowledge.isPending ? t('acknowledging') : t('acknowledge')}
      </Button>
      {error ? (
        <p
          role="alert"
          className="basis-full rounded-md bg-surface px-2.5 py-1.5 text-[13px] text-danger-alert-ink"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
