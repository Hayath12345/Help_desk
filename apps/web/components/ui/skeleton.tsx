import { cn } from "cn"

import styles from "./skeleton.module.css"

/** Track-coloured placeholder with a subtle shimmer (static when the user prefers reduced motion). */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(styles.shimmer, "rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
