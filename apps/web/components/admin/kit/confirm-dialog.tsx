'use client';

import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel: React.ReactNode;
  onConfirm: () => void;
  /** Red confirm button (archive, discard). */
  destructive?: boolean;
  /** Confirm shows as busy and can't be pressed twice. */
  busy?: boolean;
}

/**
 * A small confirmation (alertdialog): archive a row, discard unsaved changes. Focus starts on
 * Cancel (the safe choice), Escape cancels, focus returns to what opened it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  busy = false,
}: ConfirmDialogProps) {
  // Opened from code (no Radix Trigger): give focus back to what had it (the sheet's button).
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/40 duration-200 ease-out data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialogPrimitive.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={() => {
            const active = document.activeElement;
            returnFocus.current =
              active instanceof HTMLElement && active !== document.body ? active : null;
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocus.current;
            returnFocus.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          className="fixed top-1/2 start-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-2xl bg-surface p-6 text-sm text-ink shadow-modal duration-200 ease-out outline-none rtl:translate-x-1/2 sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <AlertDialogPrimitive.Title className="text-lg leading-snug font-semibold text-ink">
            {title}
          </AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description className="leading-normal text-ink-secondary">
              {description}
            </AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
            <AlertDialogPrimitive.Cancel asChild>
              <Button type="button" variant="outline">
                {cancelLabel}
              </Button>
            </AlertDialogPrimitive.Cancel>
            <Button
              type="button"
              aria-busy={busy || undefined}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onConfirm();
              }}
              className={cn(
                destructive &&
                  'bg-danger text-primary-foreground hover:bg-danger-strong aria-expanded:bg-danger-strong',
              )}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
