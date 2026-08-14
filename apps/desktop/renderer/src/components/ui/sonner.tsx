import * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * MODIFIED FROM THE REGISTRY.
 *
 * The registry version reads the active theme from `next-themes`. Artemis keeps
 * its palette in a zustand store and on a class on `<html>`, so there is no
 * theme provider to read from and pulling in a Next.js-oriented dependency to
 * learn one value made no sense. `next-themes` is not a dependency of this
 * project.
 *
 * `theme` is defaulted to `"dark"` here and overridden by the spread below, so
 * the value that actually applies is the one `ArtemisProviders` passes from the
 * store — see the note there for why sonner is told the palette at all when the
 * variables below already carry it. The default is what a bare `<Toaster />`
 * would get, and matches the palette this app renders without any script.
 *
 * The colour variables below still point at the shared tokens, so toasts
 * inherit the same floating surface as popovers and dropdown menus.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
