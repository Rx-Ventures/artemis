"use client"

import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      /*
       * `value` reaches the root, not just the indicator's transform below.
       * Destructured out of `props` and used only for the visual, it left the
       * root permanently indeterminate: no `aria-valuenow` at all, so a
       * determinate bar told a screen reader exactly as much as an
       * indeterminate one. Radix reads `null` as indeterminate, which is what
       * the callers' `undefined` means, so both cases stay honest.
       */
      value={value ?? null}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
