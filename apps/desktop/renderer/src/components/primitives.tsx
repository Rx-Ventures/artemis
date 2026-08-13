/**
 * Artemis-specific primitives.
 *
 * The small pieces that have no shadcn registry equivalent, or where the
 * registry's version does not carry Artemis's semantics. Everything here is
 * built on the same tokens as `components/ui/`, so it sits inside the design
 * system rather than beside it.
 *
 * Keep this file small. If the registry grows an equivalent, prefer the
 * registry: `pnpm dlx shadcn@latest add <name>` from `apps/desktop`.
 */

import { type ReactElement, type ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { useFold } from '@/hooks/useFold';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Tone                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The semantic hues, as a closed set.
 *
 * These are the *meanings* the transcript needs — cyan is a tool call, sage is
 * the model thinking, signal is a denial — and they have no analogue in
 * shadcn's `variant` axis, which describes emphasis rather than kind. Keeping
 * them a union rather than free-form class strings is what stops a fourteenth
 * shade of green appearing in a feature component six months from now.
 */
export type Tone = 'neutral' | 'lunar' | 'cyan' | 'sage' | 'mint' | 'amber' | 'signal';

/** Foreground + border, for outline treatments. */
const TONE_OUTLINE: Record<Tone, string> = {
  neutral: 'border-line text-ink-muted',
  lunar: 'border-lunar/40 text-lunar',
  cyan: 'border-cyan/40 text-cyan',
  sage: 'border-sage/40 text-sage',
  mint: 'border-mint/40 text-mint',
  amber: 'border-amber/40 text-amber',
  signal: 'border-signal/50 text-signal',
};

/** Solid fill, for dots and rules. */
const TONE_FILL: Record<Tone, string> = {
  neutral: 'bg-ink-faint',
  lunar: 'bg-lunar',
  cyan: 'bg-cyan',
  sage: 'bg-sage',
  mint: 'bg-mint',
  amber: 'bg-amber',
  signal: 'bg-signal',
};

/** Text only. */
const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink-muted',
  lunar: 'text-lunar',
  cyan: 'text-cyan',
  sage: 'text-sage',
  mint: 'text-mint',
  amber: 'text-amber',
  signal: 'text-signal',
};

/** Escape hatches for one-off compositions. Prefer the components below. */
export const toneClasses = {
  outline: TONE_OUTLINE,
  fill: TONE_FILL,
  text: TONE_TEXT,
} as const;

/* -------------------------------------------------------------------------- */
/* ToneBadge                                                                  */
/* -------------------------------------------------------------------------- */

export interface ToneBadgeProps {
  readonly tone?: Tone;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * A hairline, uppercase, monospaced chip — the transcript's label for what a
 * block *is*.
 *
 * Built on shadcn's `Badge` in its `outline` variant rather than replacing it:
 * use `Badge` directly for emphasis badges (counts, "new", a destructive
 * flag), and this when the badge is naming a kind of thing.
 */
export function ToneBadge({ tone = 'neutral', children, className }: ToneBadgeProps): ReactElement {
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-[17px] gap-1 rounded-sm bg-transparent px-1.5 py-0 font-mono text-2xs tracking-wide uppercase',
        TONE_OUTLINE[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */
/* StatusDot                                                                  */
/* -------------------------------------------------------------------------- */

export interface StatusDotProps {
  readonly tone?: Tone;
  readonly pulse?: boolean;
  readonly className?: string;
}

/** A 6px state indicator. Decorative — pair it with text, never alone. */
export function StatusDot({ tone = 'neutral', pulse = false, className }: StatusDotProps): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        TONE_FILL[tone],
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* ProfileSwatch                                                              */
/* -------------------------------------------------------------------------- */

export interface ProfileSwatchProps {
  /** `#rrggbb`, or absent. Absent renders nothing at all. */
  readonly color: string | undefined;
  readonly className?: string;
}

/**
 * The little square that says which profile this is.
 *
 * Deliberately *not* a {@link StatusDot} with a colour prop. A status dot draws
 * from the semantic palette, where each hue is a meaning — signal is a denial,
 * amber is a warning — and a user-chosen colour has no meaning in that
 * vocabulary. Rendering an arbitrary red next to a session row through the same
 * component that renders "this was denied" would make one look like the other.
 * A square rather than a circle, for the same reason: the shape itself says
 * "swatch, not state".
 *
 * Renders `null` without a colour, which is the ordinary case — a profile has
 * no colour unless someone picked one — so every call site can pass
 * `profile?.color` and get correct layout either way rather than reserving a
 * gap for a swatch that is not there.
 *
 * Decorative. The colour is never the only thing distinguishing two profiles:
 * the label is always beside it, which is what a screen reader reads and what
 * anyone who cannot tell the two hues apart reads too.
 */
export function ProfileSwatch({ color, className }: ProfileSwatchProps): ReactElement | null {
  if (!color) return null;
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: color }}
      className={cn(
        // A hairline ring, because a dark swatch on the dark panel and a pale
        // one on the light theme both otherwise dissolve into the background.
        'inline-block size-2 shrink-0 rounded-[3px] ring-1 ring-foreground/15',
        className,
      )}
    />
  );
}

/*
 * REMOVED: `PaneHeader`.
 *
 * It was the 32px caption strip at the top of a pane, and its whole reason for
 * existing was that three panes' headers had to line up across the window. The
 * layout is now a single transcript column with no panes at all, so it had one
 * remaining reference — the gallery — and nothing that could line up with
 * anything. A shared primitive whose only caller is the page that displays
 * shared primitives is not a primitive.
 */

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

export interface RowProps {
  readonly label: string;
  readonly children: ReactNode;
  /** Values are monospaced by default — most of them are ids, paths or counts. */
  readonly mono?: boolean;
  readonly className?: string;
}

/** A label/value line for the detail panel. Baseline-aligned, value right. */
export function Row({ label, children, mono = true, className }: RowProps): ReactElement {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-[3px]', className)}>
      <span className="shrink-0 text-2xs text-ink-faint">{label}</span>
      <span className={cn('truncate text-right text-2xs text-ink-muted', mono && 'font-mono')}>
        {children}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Fold                                                                       */
/* -------------------------------------------------------------------------- */

export interface FoldProps {
  /** The always-visible header. Rendered inside the trigger button. */
  readonly summary: ReactNode;
  readonly children: ReactNode;
  /**
   * Where this fold starts, the first time it is drawn and nobody has touched it.
   *
   * A default, not a rule — see {@link rememberAs}. Without a `rememberAs` it is
   * re-applied on every mount, which is correct for a fold whose surroundings do
   * not outlive it (a permission prompt) and was the bug for one whose do.
   */
  readonly defaultOpen?: boolean;
  /**
   * Remember an explicit open or close under this key, for the app run.
   *
   * Give it the id of the transcript row the fold belongs to. Omit it and the
   * fold is stateless between mounts, exactly as it always was.
   */
  readonly rememberAs?: string;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
}

/**
 * The transcript's disclosure: a one-line header that reveals a payload.
 *
 * A thin composition over shadcn's `Collapsible` rather than a use of it
 * directly, because this exact arrangement — chevron, clickable header row,
 * content with a small top margin — appears in the transcript, the inspector
 * and the permission prompt, and the three must open and close identically or
 * the app looks assembled from parts.
 *
 * **Not `<details>`**, deliberately: the open state has to survive the
 * re-renders driven by the external transcript store, and the header has to be
 * a real button so keyboard users can reach it. `Collapsible` gives both, plus
 * the `aria-expanded`/`aria-controls` pair for free.
 *
 * Open state is local to this component and therefore local to the transcript
 * row that owns it — which is what makes it survive a `text.delta` re-render
 * of a sibling row, since each row is memoised on its own id.
 *
 * Local, however, is not the same as forgotten. A fold given a {@link rememberAs}
 * key reads its opening position out of `lib/foldMemory` and writes every toggle
 * back, so closing a work marker and switching sessions no longer hands the
 * reader back the marker they had just closed. Nothing about the render path
 * changes: the state still lives here, and the map is only consulted at mount.
 */
export function Fold({
  summary,
  children,
  defaultOpen = false,
  rememberAs,
  className,
  triggerClassName,
  contentClassName,
}: FoldProps): ReactElement {
  const [open, setOpen] = useFold(rememberAs, defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger
        className={cn(
          'group/fold flex w-full items-center gap-1.5 rounded-sm text-left text-ink-muted transition-colors outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/50',
          triggerClassName,
        )}
      >
        <ChevronRightIcon
          className="size-3 shrink-0 text-ink-faint transition-transform duration-100 group-data-[state=open]/fold:rotate-90"
          aria-hidden="true"
        />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn('mt-1', contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  );
}

/* -------------------------------------------------------------------------- */
/* CodeBlock                                                                  */
/* -------------------------------------------------------------------------- */

export interface CodeBlockProps {
  readonly text: string;
  readonly tone?: 'neutral' | 'error';
  readonly className?: string;
}

/**
 * A recessed, scrollable well for verbatim output — tool results, stack
 * traces, raw JSON.
 *
 * `whitespace-pre-wrap` plus `break-words`: agent output arrives with
 * arbitrarily long unbroken tokens (paths, base64, minified JSON) and a pane
 * that scrolls sideways forever is unreadable.
 */
export function CodeBlock({ text, tone = 'neutral', className }: CodeBlockProps): ReactElement {
  return (
    <pre
      className={cn(
        'max-h-72 overflow-auto rounded-md border bg-inset px-2.5 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap',
        tone === 'error' ? 'border-signal/35 text-signal' : 'border-line text-ink-muted',
        className,
      )}
    >
      {text}
    </pre>
  );
}
