import * as React from "react"
// RetroUI button, trimmed vs the registry original: secondary/link variants and
// xs/lg/icon-xs/icon-lg sizes dropped (unused). Re-running `shadcn add @retroui/button`
// silently restores the full set — re-apply the trim if you do.
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  cn(
    "group/button font-head font-medium inline-flex cursor-pointer items-center justify-center gap-2 rounded whitespace-nowrap select-none transition-all duration-200",
    "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-invalid:border-destructive",
    // Icons keep their own size; we only set a default when none is given so
    // RetroUI's h-4/size-4 icons aren't overridden.
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
  ),
  {
    variants: {
      variant: {
        default:
          "border-2 border-black bg-primary text-primary-foreground shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-primary-hover hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        destructive:
          "border-2 border-black bg-destructive text-destructive-foreground shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-destructive/90 hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        outline:
          "border-2 bg-transparent shadow-md transition duration-200 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-lg active:translate-x-1 active:translate-y-1 active:shadow-none",
        ghost: "bg-transparent hover:bg-accent",
      },
      size: {
        default: "px-4 py-1.5 text-base",
        sm: "px-3 py-1 text-sm",
        icon: "p-2",
        "icon-sm": "p-1.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button }
