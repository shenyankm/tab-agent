import * as React from "react"
// RetroUI switch, trimmed vs the registry original: size prop and the after:
// expanded click area dropped (unused). Re-running `shadcn add @retroui/switch`
// silently restores them — re-apply the trim if you do.
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center border-2 border-foreground bg-muted transition-all outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-invalid:border-destructive data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none mx-0.5 block size-4 border-2 border-foreground bg-primary transition-transform data-checked:translate-x-5 data-checked:bg-background data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
