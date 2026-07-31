import * as React from "react"

import { cn } from "@/lib/utils"

// visual port of https://neobrutalism.com/docs/components/menubar (bar + flat
// triggers); plain buttons because our triggers switch views, they open no menus
function Menubar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="menubar"
      className={cn(
        "flex h-8 items-center gap-0.5 rounded border-2 bg-background p-[3px] shadow-md",
        className
      )}
      {...props}
    />
  )
}

function MenubarTrigger({
  className,
  active,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="menubar-trigger"
      aria-pressed={active}
      className={cn(
        "flex cursor-pointer items-center rounded-sm px-1.5 py-[2px] text-sm font-medium outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        active && "bg-accent text-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Menubar, MenubarTrigger }
