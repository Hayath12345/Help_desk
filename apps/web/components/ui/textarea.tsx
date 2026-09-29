import * as React from 'react';
import { cn } from 'cn';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-20 w-full rounded-md border border-line-input bg-surface px-3 py-2.5 text-base text-ink transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-ink-muted focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint focus-visible:outline-hidden disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted aria-invalid:border-danger-strong aria-invalid:focus-visible:ring-danger-tint md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
