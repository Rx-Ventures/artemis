import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * MODIFIED FROM THE REGISTRY.
 *
 * The registry version carries `in-data-[slot=tooltip-content]:*` overrides
 * that repaint the key cap for the stock *inverted* tooltip. Libra's tooltip
 * sits on the normal floating surface (see `tooltip.tsx`), so those overrides
 * would invert a key cap that is already on the right background. Removed —
 * one styling for a key cap, wherever it appears.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border border-line bg-inset px-1 font-sans text-2xs font-medium text-ink-faint select-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
