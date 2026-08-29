/**
 * The furniture every settings pane is built from.
 * ============================================================================
 *
 * Nine panes live behind one dialog, and they were written to feel like nine
 * views of the same surface rather than nine screens that happen to share a
 * frame. That only holds if the title block, the setting row and the "pick one
 * of these" control are literally the same components everywhere — the moment
 * one pane hand-rolls its own heading, the section nav starts to read like
 * navigation between apps.
 *
 * ---------------------------------------------------------------------------
 * WHY `ChoiceList` EXISTS AND IS NOT A ROW OF BUTTONS
 * ---------------------------------------------------------------------------
 *
 * Several panes need the same control: "choose exactly one of these, and show
 * me what each one costs me" — conversation width in Appearance, permission
 * mode in Permissions & access, the run summary in Runs. The sets are small,
 * each option needs a sentence, and in every case the sentence is the entire
 * point (nobody knows what `acceptEdits` means from its name).
 *
 * A `Select` hides the sentences behind a click. A row of `aria-pressed`
 * buttons says "several of these can be on", which is wrong. So this is a real
 * radiogroup — shadcn's `RadioGroup`, which is Radix underneath: one tab stop
 * for the whole group, arrows moving between options, selection following
 * focus. That is what a screen-reader user is told to expect the moment they
 * hear "radio group", and what a native `<input type=radio>` set gives them.
 *
 * It was hand-rolled here first, faithfully — roving `tabIndex`, an
 * Arrow/Home/End handler, wrap-around that skipped disabled options. All of it
 * deleted when `RadioGroup` was installed. The pattern was already implemented
 * correctly by someone whose job it is; carrying a second copy only created a
 * second place for it to be subtly wrong.
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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
  /**
   * Deep-link target. `openSettings(section, { row })` scrolls the group
   * carrying this id into view once the pane mounts — see the dialog's anchor
   * effect. An address like the section ids: once a caller links to it, the
   * string is frozen even if the group is renamed or rehomed.
   */
  readonly anchor?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A titled band of related settings. The uppercase rule matches the inspector. */
export function SettingsGroup({
  label,
  anchor,
  children,
  className,
}: SettingsGroupProps): ReactElement {
  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      {...(anchor === undefined ? {} : { 'data-settings-row': anchor })}
    >
      {label ? (
        <h3 className="chrome-label text-ink-faint">{label}</h3>
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
  /*
   * Radix owns the keyboard, deliberately.
   *
   * This was ~70 lines of hand-rolled radiogroup: a roving `tabIndex`, an
   * Arrow/Home/End handler, a `step` that skipped disabled options and wrapped,
   * and a ref array to move focus. All of it is WAI-ARIA's radiogroup pattern,
   * all of it is what `RadioGroup` already implements, and re-implementing an
   * accessibility pattern is how you end up with a subtly wrong one nobody
   * tests. The visual treatment — card rows, tone-coloured labels, a reason on
   * the disabled ones — is unchanged; only the mechanics moved.
   *
   * The row is a `<label>` wrapping the control, which is what makes the whole
   * card clickable without re-implementing hit-testing, and what lets the focus
   * ring live on the card via `has-focus-visible` while focus itself sits on
   * the real radio.
   */
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className={cn('flex flex-col gap-1.5', className)}
    >
      {choices.map((choice) => {
        const checked = choice.id === value;
        const row = (
          <label
            key={choice.id}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
              'has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
              checked
                ? 'border-beam/45 bg-beam/5'
                : 'border-line bg-panel hover:border-line-strong hover:bg-raised',
              choice.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            <RadioGroupItem
              value={choice.id}
              disabled={choice.disabled ?? false}
              className="mt-[3px] shrink-0 border-line-strong data-[state=checked]:border-beam data-[state=checked]:text-beam"
            />
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
          </label>
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
            {row}
          </WithReason>
        ) : (
          row
        );
      })}
    </RadioGroup>
  );
}
