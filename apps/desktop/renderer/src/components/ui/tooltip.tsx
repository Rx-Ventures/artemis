import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

/**
 * MODIFIED FROM THE REGISTRY. Two deliberate departures:
 *
 * 1. Surface. The stock Nova tooltip is inverted — `bg-foreground` on
 *    `text-background`, i.e. a near-white bubble. That is fine for a two-word
 *    label, but Libra's most important tooltip is the sentence explaining why
 *    a control is disabled (see `CapabilityButton`), and a paragraph of black
 *    text on white glares badly in a dark, long-session tool. Tooltips sit on
 *    the same floating surface as popovers and menus instead, so everything
 *    that overlays the app reads as one layer.
 *
 * 2. No arrow. A bordered bubble plus a rotated-square arrow needs the arrow
 *    to carry a border on exactly its two outward faces, which is fragile
 *    across sides. Offset bubbles without arrows are the norm in dev tooling,
 *    and the tooltip is anchored tightly enough that the arrow earns nothing.
 */
function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-[18rem] origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md border border-line-strong bg-popover px-2.5 py-1.5 text-xs leading-snug text-popover-foreground shadow-lg shadow-black/40 has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
