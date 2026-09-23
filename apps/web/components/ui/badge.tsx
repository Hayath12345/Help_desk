import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Design pills: 12px medium, 2px 8px padding, 6px radius, tinted backgrounds.
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-200 ease-out has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-invalid:border-danger-strong [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-brand-tint text-brand-ink [a]:hover:bg-brand-soft",
        secondary:
          "bg-surface-sunken text-ink-secondary [a]:hover:bg-track",
        destructive: "bg-danger-tint text-danger",
        success: "bg-success-tint text-success",
        warning: "bg-status-pending-bg text-status-pending-fg",
        note: "bg-note-tag text-note-ink",
        outline:
          "border-line bg-surface text-ink [a]:hover:bg-surface-sunken",
        ghost: "text-ink-secondary hover:bg-surface-sunken",
        link: "px-0 text-brand-ink underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
