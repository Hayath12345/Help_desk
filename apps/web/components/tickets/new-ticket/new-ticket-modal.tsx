'use client';

import type { TicketDetailDto } from '@loons/shared';
import { useIsMutating } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { LoadingRegion, SkeletonText } from '@/components/common/skeletons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useTicketFormConfig } from '@/lib/tickets/queries';
import { NewTicketForm, type NewTicketDefaults } from './new-ticket-form';

export interface NewTicketModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isStaff: boolean;
  defaults?: NewTicketDefaults;
  onCreated: (ticket: TicketDetailDto) => void;
  /** Where focus goes when the dialog closes (it has no DialogTrigger of its own). */
  returnFocusTo?: () => HTMLElement | null;
}

/** Header + skeleton rows + footer while the live configuration loads (or failed to). */
function FormPlaceholder({
  failed,
  onRetry,
  onCancel,
}: {
  failed: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('tickets.newTicket');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-divider px-6 py-[18px]">
        <DialogPrimitive.Title className="text-lg font-semibold text-ink">
          {t('title')}
        </DialogPrimitive.Title>
        <DialogPrimitive.Close asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('close')}
            className="text-ink-muted"
          >
            <X aria-hidden="true" className="size-5" />
          </Button>
        </DialogPrimitive.Close>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5">
        {failed ? (
          <div className="flex flex-col items-start gap-3 py-6">
            <p role="alert" className="text-ink-secondary">
              {t('loadFailed')}
            </p>
            <Button type="button" variant="outline" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : (
          <LoadingRegion label={t('loading')} className="flex flex-col gap-[18px]">
            <div className="flex flex-col gap-2">
              <SkeletonText className="w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
            <div className="flex flex-col gap-2">
              <SkeletonText className="w-16" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-24 w-full" />
          </LoadingRegion>
        )}
      </div>
      <div className="flex items-center justify-end gap-2.5 border-t border-divider px-6 py-3.5">
        <Button type="button" variant="outline" onClick={onCancel} className="h-auto py-[9px]">
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The New ticket dialog: scale + fade in, focus trapped, Escape / overlay / × / Cancel close (none
 * of them while the ticket is being created). Loads the live form configuration when opened; the
 * form resets every time the dialog opens (the content unmounts on close).
 */
export function NewTicketModal({
  open,
  onOpenChange,
  isStaff,
  defaults,
  onCreated,
  returnFocusTo,
}: NewTicketModalProps) {
  const config = useTicketFormConfig({ enabled: open });
  const creating = useIsMutating({ mutationKey: ['tickets', 'create'] }) > 0;
  const dismiss = () => {
    if (!creating) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : dismiss())}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          // The form focuses its first field itself; until it has loaded, focus the dialog.
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          if (content && !content.contains(document.activeElement)) content.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
        className="flex max-h-[94vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]"
      >
        {config.data ? (
          <NewTicketForm
            config={config.data}
            isStaff={isStaff}
            defaults={defaults}
            onCancel={dismiss}
            onCreated={onCreated}
          />
        ) : (
          <FormPlaceholder
            failed={config.isError}
            onRetry={() => void config.refetch()}
            onCancel={dismiss}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
