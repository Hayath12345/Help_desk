'use client';

import { LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { outlineButtonClass, primaryButtonClass } from './styles';

type SubmitButtonProps = Omit<React.ComponentProps<typeof Button>, 'variant' | 'type'> & {
  /** Pending state from useActionState; the enclosing form's status is used as well. */
  pending?: boolean;
  appearance?: 'primary' | 'outline';
  /** Shown before the label when not pending (e.g. a provider logo). */
  icon?: React.ReactNode;
};

/**
 * Submit button that shows a spinner while its form is submitting.
 *
 * While pending it is `aria-disabled` + `aria-busy`, not `disabled`: disabling the focused button
 * would drop keyboard focus to <body> (UI-RR-1). A second submit is blocked in the click handler
 * instead — the click is what submits the form, whether from a pointer, Enter/Space on the button
 * or Enter in a field (implicit submission clicks the default button).
 */
export function SubmitButton({
  pending: pendingProp = false,
  appearance = 'primary',
  icon,
  className,
  onClick,
  children,
  ...props
}: SubmitButtonProps) {
  const t = useTranslations('auth');
  const status = useFormStatus();
  const pending = pendingProp || status.pending;

  return (
    <Button
      type="submit"
      variant={appearance === 'primary' ? 'default' : 'outline'}
      {...props}
      aria-disabled={pending || props['aria-disabled'] || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(
        appearance === 'primary' ? primaryButtonClass : outlineButtonClass,
        // Pending, not unavailable: a progress cursor instead of the kit's not-allowed one.
        pending && 'aria-disabled:cursor-progress',
        // …and no hover change (the kit's pointer-events-none only applies to `disabled`).
        pending && (appearance === 'primary' ? 'hover:bg-brand' : 'hover:bg-surface'),
        className,
      )}
    >
      {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : icon}
      <span>{children}</span>
      {pending ? <span className="sr-only">{t('working')}</span> : null}
    </Button>
  );
}
