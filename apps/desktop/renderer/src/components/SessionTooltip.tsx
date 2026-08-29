/**
 * What a sidebar row says when you hover it.
 * ============================================================================
 *
 *      ╭──────────────────────────────╮
 *      │ Wire the adapter seam across │
 *      │ both transports              │
 *      │ ● Running now                │
 *      │ ──────────────────────────── │
 *      │ directory  /Users/ada/code/  │
 *      │            artemis           │
 *      │ branch     feat/adapter-seam │
 *      │ profile    ▪ Work            │
 *      │ model      claude-fable-5    │
 *      │ messages   34                │
 *      │ activity   4m ago            │
 *      ╰──────────────────────────────╯
 *
 * The row itself is two truncated lines in a ~240px column, so the tooltip is
 * where the rest of the session lives. It used to be one dash-joined sentence
 * — `Resume — /Users/ada/code/artemis — Work — 4m ago` — and the sentence is
 * what overflowed (#85): a working directory is a single unbroken token, the
 * bubble caps its width at 18rem, and a token with no break opportunities
 * walked straight through the border and kept going.
 *
 * So the sentence became a card. The title gets its own line at full length
 * rather than `condenseTitle`'s eight words; the facts under it are a
 * label/value grid in the run-info dialog's vocabulary — lowercase labels,
 * monospaced values. And the overflow is fixed where it lived, in the
 * wrapping: monospaced values are paths, branches and model ids, which have
 * no spaces, so they carry `break-all`; prose carries `wrap-anywhere`; the
 * body is `min-w-0` so the flex parent (`TooltipContent`) is allowed to
 * clamp it to the bubble at all.
 *
 * *Which* rows appear, and what they say, is `lib/sessionTooltip.ts` — pure
 * and unit-tested. This file only draws.
 *
 * Two states never reach this component, on purpose:
 *
 * - An orphaned row (profile deleted) is disabled, and `ReasonButton` shows
 *   its `disabledReason` sentence in place of the tooltip — "why can't I
 *   click this" outranks detail about a click that cannot happen.
 * - `running` arrives as a prop rather than a subscription. The Row already
 *   reads `runningSessions`; a second subscription per tooltip would double
 *   the sidebar's per-row cost for the same boolean.
 */

import { Fragment, type ReactElement } from 'react';
import type { ProfileMetadata, SessionSummary } from '@rx-artemis/protocol';

import { sessionCountLabel, sessionTooltipRows, sessionTooltipTitle } from '../lib/sessionTooltip';
import { lastSegment } from '../lib/paths';
import { ProfileSwatch, StatusDot } from './primitives';
import { cn } from '@/lib/utils';

/** The body of a session row's tooltip. Render inside a `TooltipContent`. */
export function SessionTooltip({
  session,
  profile,
  running,
}: {
  readonly session: SessionSummary;
  readonly profile: ProfileMetadata | undefined;
  readonly running: boolean;
}): ReactElement {
  const rows = sessionTooltipRows(session, { profileLabel: profile?.label });

  return (
    <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
      <p className="text-xs leading-snug font-medium wrap-anywhere text-ink">
        {sessionTooltipTitle(session.title)}
      </p>

      {running ? (
        <p className="flex items-center gap-1.5 text-2xs leading-snug text-cyan">
          <StatusDot tone="cyan" pulse />
          Running now
        </p>
      ) : null}

      {/* A hairline, not `--line`: this rule separates the title from the
          facts under it and separates nothing else, which is exactly the
          decorative seam Console draws in alpha. */}
      <div aria-hidden="true" className="h-px bg-hairline-strong" />

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-2xs leading-snug text-ink-faint">{row.label}</dt>
            <dd
              className={cn(
                'min-w-0 text-2xs leading-snug text-ink-muted',
                row.mono ? 'font-mono break-all' : 'wrap-anywhere',
              )}
            >
              {/*
                The swatch is the account's colour, so it is drawn only when
                there is an account. On a row whose owner was never recorded
                `profile` is the adapter's arbitrary pick among the sharers —
                painting its colour here would put a confident dot next to the
                words "not recorded", which is the contradiction the row above
                already avoids by showing nothing.
              */}
              {row.label === 'profile' ? (
                <span className="flex min-w-0 items-center gap-1">
                  {session.profileIsUnknown === true ? null : (
                    <ProfileSwatch color={profile?.color} />
                  )}
                  <span className="min-w-0 wrap-anywhere">{row.value}</span>
                </span>
              ) : (
                row.value
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

/**
 * The body of a project heading's tooltip: name, full root, session count.
 *
 * The heading shows `lastSegment(project)` and used to put the full root on a
 * native `title` — the one hover surface in the sidebar the app did not draw
 * itself, which meant OS chrome next to styled bubbles and a different answer
 * on every platform. Same primitives as the session tooltip now, and the root
 * gets the same `break-all` treatment, since it is the same kind of token
 * that was escaping the session bubble.
 */
export function ProjectTooltip({
  project,
  count,
}: {
  readonly project: string;
  readonly count: number;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-1 py-0.5">
      <p className="text-xs leading-snug font-medium wrap-anywhere text-ink">
        {lastSegment(project)}
      </p>
      <p className="font-mono text-2xs leading-snug break-all text-ink-muted">{project}</p>
      <p className="text-2xs leading-snug text-ink-faint">{sessionCountLabel(count)}</p>
    </div>
  );
}
