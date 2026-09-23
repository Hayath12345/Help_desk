import * as React from "react"
import { cn } from "cn"

// Design: 10px 12px padding, 8px radius, input-grey border; focus → brand border + 3px brand-tint ring.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-line-input bg-surface px-3 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 ease-out outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink placeholder:text-ink-subtle focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand-tint disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-muted aria-invalid:border-danger-strong aria-invalid:focus-visible:ring-danger-tint md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
