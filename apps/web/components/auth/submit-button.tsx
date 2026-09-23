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

/** Submit button that disables itself and shows a spinner while its form is submitting. */
export function SubmitButton({
  pending: pendingProp = false,
  appearance = 'primary',
  icon,
  className,
  disabled,
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
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(appearance === 'primary' ? primaryButtonClass : outlineButtonClass, className)}
      {...props}
    >
      {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : icon}
      <span>{children}</span>
      {pending ? <span className="sr-only">{t('working')}</span> : null}
    </Button>
  );
}
