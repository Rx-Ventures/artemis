/**
 * The furniture every settings pane is built from.
 * ============================================================================
 *
 * Four panes live behind one dialog, and they were written to feel like four
 * views of the same surface rather than four screens that happen to share a
 * frame. That only holds if the title block, the setting row and the "pick one
 * of these" control are literally the same components everywhere — the moment
 * one pane hand-rolls its own heading, the section nav starts to read like
 * navigation between apps.
 *
 * ---------------------------------------------------------------------------
 * WHY `ChoiceList` EXISTS AND IS NOT A ROW OF BUTTONS
 * ---------------------------------------------------------------------------
 *
 * Two panes need the same control: "choose exactly one of these, and show me
 * what each one costs me" — conversation width in Appearance, permission mode
 * in Permissions. Both sets are small, both need a sentence per option, and in
 * both cases the sentence is the entire point (nobody knows what
 * `acceptEdits` means from its name).
 *
 * A `Select` hides the sentences behind a click. A row of `aria-pressed`
 * buttons says "several of these can be on", which is wrong. shadcn's
 * `RadioGroup` is not installed in this app and adding a registry component
 * was not in this change's remit. So this is a real radiogroup built by hand:
 * `role="radiogroup"` on the container, `role="radio"` + `aria-checked` on each
 * option, **one** tab stop for the whole group with the arrows moving between
 * options — which is what a screen-reader user is told to expect the moment
 * they hear "radio group", and what they get from a native `<input
 * type=radio>` set. Selection follows focus, as it does natively.
 *
 * Options that cannot be chosen keep their place in the list, disabled, with
 * the reason attached — the same rule `disabled-reason.tsx` exists to enforce.
 * A permission mode that vanishes under one provider teaches the user nothing
 * about why it is gone.
 */

import * as React from 'react';
import type { ReactElement, ReactNode } from 'react';

import { WithReason } from '../disabled-reason';
import { toneClasses, type Tone } from '../primitives';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/* Pane                                                                       */
/* -------------------------------------------------------------------------- */

export interface SettingsPaneProps {
  readonly title: string;
  /** One line on what this pane decides. Always present — a pane with nothing to say about itself is a pane that did not need its own section. */
  readonly description: string;
  /** Controls that act on the pane as a whole, right-aligned in the title row. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/**
 * A pane's title block plus its content column.
 *
 * Deliberately not scrollable and not height-constrained: the dialog owns the
 * single scroll container (see `SettingsDialog`), so a pane that grew its own
 * would produce the nested-scrollbar effect where the mouse wheel stops working
 * at a boundary the user cannot see.
 */
export function SettingsPane({
  title,
  description,
  actions,
  children,
}: SettingsPaneProps): ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-faint">{description}</p>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Group                                                                      */
/* -------------------------------------------------------------------------- */

export interface SettingsGroupProps {
  /** Small caps rule above the group. Omit for a group that needs no name. */
  readonly label?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A titled band of related settings. The uppercase rule matches the inspector. */
export function SettingsGroup({ label, children, className }: SettingsGroupProps): ReactElement {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      {label ? (
        <h3 className="font-mono text-2xs tracking-[0.14em] text-ink-faint uppercase">{label}</h3>
      ) : null}
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* ChoiceList                                                                 */
/* -------------------------------------------------------------------------- */

export interface Choice<T extends string> {
  readonly id: T;
  readonly label: string;
  /** What choosing this costs or buys. Shown under the label, always. */
  readonly note: string;
  /** Colours the label only — for the one option that deserves a warning. */
  readonly tone?: Tone;
  readonly disabled?: boolean;
  /** Why it is disabled. Required in practice whenever `disabled` is set. */
  readonly reason?: string;
}

export interface ChoiceListProps<T extends string> {
  /** Accessible name for the group. Not rendered — pair with a visible heading. */
  readonly label: string;
  readonly value: T;
  readonly choices: readonly Choice<T>[];
  readonly onChange: (value: T) => void;
  readonly className?: string;
}

export function ChoiceList<T extends string>({
  label,
  value,
  choices,
  onChange,
  className,
}: ChoiceListProps<T>): ReactElement {
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * The one option that carries the group's tab stop.
   *
   * The checked one, or — when the stored value names nothing in this list,
   * which happens whenever a preference outlives the provider that offered it
   * — the first. A group where every option is `tabIndex={-1}` is unreachable
   * by keyboard entirely, so there is always exactly one.
   */
  const checkedIndex = choices.findIndex((choice) => choice.id === value);
  const tabIndex = checkedIndex >= 0 ? checkedIndex : 0;

  /** Move selection by `delta`, skipping disabled options and wrapping. */
  function step(from: number, delta: number): void {
    const count = choices.length;
    for (let hop = 1; hop <= count; hop += 1) {
      const next = (((from + delta * hop) % count) + count) % count;
      const choice = choices[next];
      if (!choice || choice.disabled) continue;
      onChange(choice.id);
      buttons.current[next]?.focus();
      return;
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        step(index, 1);
        return;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        step(index, -1);
        return;
      case 'Home':
        event.preventDefault();
        step(-1, 1);
        return;
      case 'End':
        event.preventDefault();
        step(0, -1);
        return;
      default:
        return;
    }
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn('flex flex-col gap-1.5', className)}>
      {choices.map((choice, index) => {
        const checked = choice.id === value;
        const button = (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={choice.disabled ? true : undefined}
            tabIndex={index === tabIndex ? 0 : -1}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => {
              if (!choice.disabled) onChange(choice.id);
            }}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors outline-none',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
              checked
                ? 'border-brass/45 bg-brass/5'
                : 'border-line bg-panel hover:border-line-strong hover:bg-raised',
              choice.disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {/* Drawn rather than composed from `Checkbox`: that component is a
                Radix checkbox with checkbox semantics, and putting one inside a
                `role="radio"` would announce two conflicting roles. This is
                decoration — `aria-checked` above carries the state. */}
            <span
              aria-hidden="true"
              className={cn(
                'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                checked ? 'border-brass' : 'border-line-strong',
              )}
            >
              {checked ? <span className="size-1.5 rounded-full bg-brass" /> : null}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={cn(
                  'text-xs leading-snug font-medium',
                  choice.tone ? toneClasses.text[choice.tone] : 'text-ink',
                )}
              >
                {choice.label}
              </span>
              <span className="text-2xs leading-relaxed text-ink-faint">{choice.note}</span>
            </span>
          </button>
        );

        // `WithReason` renders children untouched when there is no reason, so
        // the wrapper span only appears on the options that need to explain
        // themselves — and `w-full` keeps it from shrink-wrapping the row.
        return choice.disabled && choice.reason ? (
          <WithReason
            key={choice.id}
            reason={choice.reason}
            focusable={false}
            side="right"
            className="w-full"
          >
            {button}
          </WithReason>
        ) : (
          button
        );
      })}
    </div>
  );
}
