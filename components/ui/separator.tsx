import * as React from "react"

import { cn } from "@/lib/utils"

// neobrutalism separator, de-sugared: a decorative div covers it — no @base-ui dep
function Separator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="separator"
      className={cn("h-px w-full shrink-0 bg-border", className)}
      {...props}
    />
  )
}

export { Separator }
