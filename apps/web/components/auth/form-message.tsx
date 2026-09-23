import { cn } from '@/lib/utils';

/** Error box (13px, danger text on danger tint, 8px radius). Announced to screen readers. */
export function FormError({ className, children, ...props }: React.ComponentProps<'div'>) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md bg-danger-tint px-2.5 py-2 text-[13px] leading-normal text-danger',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** Success / information box in the same shape as the error box. */
export function FormNotice({ className, children, ...props }: React.ComponentProps<'div'>) {
  if (!children) return null;
  return (
    <div
      role="status"
      className={cn(
        'rounded-md bg-success-tint px-2.5 py-2 text-[13px] leading-normal text-success',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
