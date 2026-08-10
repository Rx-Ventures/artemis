import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * MODIFIED FROM THE REGISTRY: `[&>div]:block!` on the viewport.
 *
 * Radix wraps whatever you put inside `Viewport` in a div it styles
 * `min-width: 100%; display: table`. A table box is shrink-to-fit *and*
 * grow-to-content, so any descendant with an intrinsic width wider than the
 * pane — a `whitespace-nowrap` metadata line, a long unbroken path — widens
 * that wrapper instead of being clipped or truncated by it. The visible symptom
 * is a `truncate` that never truncates and a pane whose rows run under its own
 * edge; it cost a rebuild of the sessions rail to find, so it is fixed here
 * once rather than at each call site.
 *
 * Forcing the wrapper to `block` restores normal block sizing, at the cost of
 * Radix's automatic horizontal-scroll measurement. Nothing in Apollo scrolls a
 * `ScrollArea` sideways — wide content gets its own `overflow-x` container —
 * so that trade is free here. If a future pane does need it, give that pane a
 * plain overflow container instead of reverting this.
 */
function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 [&>div]:block!"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
