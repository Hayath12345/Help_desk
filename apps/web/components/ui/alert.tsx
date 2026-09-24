import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-md border px-2.5 py-2 text-start text-[13px] leading-snug has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pe-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-px *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-line bg-surface text-ink',
        // Design error box: 13px danger text on danger-tint, 8px 10px padding, 8px radius.
        destructive:
          'border-transparent bg-danger-tint text-danger *:data-[slot=alert-description]:text-danger',
        success:
          'border-transparent bg-success-tint text-success *:data-[slot=alert-description]:text-success',
        info: 'border-transparent bg-brand-tint text-brand-ink *:data-[slot=alert-description]:text-brand-ink',
        warning:
          'border-note-border bg-note-bg text-note-ink *:data-[slot=alert-description]:text-note-ink',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-ink',
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-[13px] text-balance text-ink-muted md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-ink [&_p:not(:last-child)]:mb-2',
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-action" className={cn('absolute top-2 end-2', className)} {...props} />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
