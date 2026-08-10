/**
 * Controls that explain themselves when they are unavailable.
 * ============================================================================
 *
 * Apollo drives several agent CLIs over unrelated transports, and not all of
 * them can do everything. The design rule that falls out of that is absolute:
 * **a control that cannot be used is shown, disabled, with a sentence saying
 * why** — never hidden, never disabled in silence. A user who cannot find the
 * fork button assumes Apollo is broken; a user who sees a dimmed fork button
 * saying "Codex does not support forking a session" has learnt something.
 *
 * This module is the mechanism for that rule, and it is deliberately free of
 * any dependency on application state — it knows about reasons, not about
 * capabilities. `capability-button.tsx` layers the capability lookup on top.
 * Keeping the split means this half is trivially testable and reusable for any
 * "disabled because…" case, capability-driven or not.
 *
 * ---------------------------------------------------------------------------
 * WHY AN EXPLAINED-DISABLED BUTTON IS NOT `disabled`
 * ---------------------------------------------------------------------------
 *
 * A natively disabled `<button>` fires no pointer events and takes no focus.
 * Both are fatal here: no pointer events means no hover, so the tooltip
 * carrying the explanation can never open, and no focus means a keyboard or
 * screen-reader user can never reach the explanation at all. The usual dodge —
 * wrapping the button in a `<span>` that catches the hover — works, but the
 * span becomes the flex item in every toolbar it appears in, so `flex-1` and
 * `w-full` from the caller silently stop working and layout shifts the moment
 * a control becomes unavailable.
 *
 * So an *explained* disabled button keeps `aria-disabled="true"` and drops the
 * native attribute. It stays hoverable and focusable, screen readers still
 * announce it as disabled, Radix puts `aria-describedby` on the button itself
 * so the explanation is part of its accessible description, and there is no
 * wrapper element to disturb layout. Activation is blocked in JS instead —
 * `blockActivation` below swallows the click, which also covers Enter and
 * Space, since both dispatch a click on a focused button.
 *
 * A disabled button with *no* reason keeps the native attribute. There is
 * nothing to explain, so there is no reason to give up the browser's own
 * semantics.
 *
 * The visible trade-off, stated plainly: because pointer events stay live, a
 * variant's `hover:` background still responds under the cursor. That is
 * accepted rather than fought — the control genuinely is interactive (it
 * answers with a tooltip), and `cursor-not-allowed` plus 50% opacity carry the
 * unavailability. Suppressing the hover generically would mean overriding a
 * different background for every variant, which breaks the moment the registry
 * adds one.
 */

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type TooltipSide = React.ComponentProps<typeof TooltipContent>['side'];
type TooltipAlign = React.ComponentProps<typeof TooltipContent>['align'];

/** Swallows activation on a control that is disabled-but-focusable. */
function blockActivation(event: React.MouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

/* -------------------------------------------------------------------------- */
/* WithReason                                                                 */
/* -------------------------------------------------------------------------- */

export interface WithReasonProps {
  /**
   * The explanation. Falsy renders `children` completely untouched — no
   * wrapper element, no tooltip, nothing in the DOM at all.
   */
  readonly reason?: string | undefined;
  readonly side?: TooltipSide;
  readonly align?: TooltipAlign;
  /**
   * Whether the wrapper takes keyboard focus. Default `true`, which is what
   * you want around a natively-disabled control: the control itself is out of
   * the tab order, so the wrapper takes its place rather than adding a stop,
   * and tabbing to it surfaces the explanation. Set `false` when the wrapped
   * control is still focusable in its own right.
   */
  readonly focusable?: boolean;
  /** Applied to the wrapper span, not the child. */
  readonly className?: string;
  readonly children: React.ReactNode;
}

/**
 * Attaches an explanation to any control, including one that is natively
 * `disabled` and therefore deaf to pointer events — a `<select>`, a checkbox,
 * a shadcn `Switch`.
 *
 * Prefer {@link ReasonButton} for buttons: it needs no wrapper and so cannot
 * disturb layout. Reach for this when the control cannot be made
 * `aria-disabled` instead of `disabled`.
 */
export function WithReason({
  reason,
  side = 'top',
  align = 'center',
  focusable = true,
  className,
  children,
}: WithReasonProps): React.ReactElement {
  if (!reason) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // `inline-flex` so the wrapper hugs the control rather than
          // stretching to a line box, and so its baseline matches.
          className={cn('inline-flex', className)}
          tabIndex={focusable ? 0 : undefined}
          data-slot="reason-wrapper"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* ReasonButton                                                               */
/* -------------------------------------------------------------------------- */

export interface ReasonButtonProps extends React.ComponentProps<typeof Button> {
  /**
   * Why this button cannot be used. Shown as a tooltip, but only while the
   * button is also `disabled` — a reason on an enabled button is meaningless
   * and is ignored rather than rendered.
   */
  readonly disabledReason?: string | undefined;
  /** Tooltip for the *enabled* state. `disabledReason` takes precedence. */
  readonly tooltip?: React.ReactNode;
  readonly tooltipSide?: TooltipSide;
  readonly tooltipAlign?: TooltipAlign;
}

/**
 * A shadcn `Button` that can explain its own disabled state.
 *
 * ```tsx
 * <ReasonButton
 *   disabled={!canFork}
 *   disabledReason="Codex does not support forking a session."
 *   onClick={fork}
 * >
 *   Fork
 * </ReasonButton>
 * ```
 *
 * Renders exactly one element — the button — so it drops into a flex toolbar
 * without changing how the caller's `className` behaves.
 */
export function ReasonButton({
  disabled = false,
  disabledReason,
  tooltip,
  tooltipSide = 'top',
  tooltipAlign = 'center',
  className,
  onClick,
  type = 'button',
  ...props
}: ReasonButtonProps): React.ReactElement {
  const explained = disabled && Boolean(disabledReason);
  const message: React.ReactNode = explained ? disabledReason : tooltip;

  const button = (
    <Button
      // `type` defaults to "button" and not the platform's "submit": most of
      // these live in toolbars, and a stray submit inside the profile form is
      // a far worse failure than an explicit `type="submit"` at the one call
      // site that wants it. Spread last, so callers can still override.
      type={type}
      disabled={disabled && !explained}
      aria-disabled={explained ? true : undefined}
      onClick={explained ? blockActivation : onClick}
      className={cn(
        explained &&
          // Mirrors what `disabled:` would have done, minus the
          // `pointer-events-none` that would kill the tooltip.
          'cursor-not-allowed opacity-50 shadow-none active:translate-y-0',
        className,
      )}
      {...props}
    />
  );

  if (!message) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide} align={tooltipAlign}>
        {message}
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* IconButton                                                                 */
/* -------------------------------------------------------------------------- */

export interface IconButtonProps extends Omit<ReasonButtonProps, 'tooltip'> {
  /**
   * Required, and doing double duty: it is the button's accessible name *and*
   * its tooltip. An icon-only control with no name is unusable with a screen
   * reader and ambiguous with a mouse, so the type system asks for it once and
   * wires up both.
   */
  readonly label: string;
}

/**
 * An icon-only {@link ReasonButton}. Always tooltipped: `label` normally, and
 * `disabledReason` when it is disabled and has one.
 */
export function IconButton({
  label,
  size = 'icon-sm',
  variant = 'ghost',
  ...props
}: IconButtonProps): React.ReactElement {
  return (
    <ReasonButton
      aria-label={label}
      tooltip={label}
      size={size}
      variant={variant}
      {...props}
    />
  );
}
