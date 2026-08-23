/**
 * The update card — a floating card at the foot of the sidebar, shown only when
 * there is an update to say something about.
 *
 *      ╭────────────────────────────────╮
 *      │ [ + New session       ⌘N ] [◧] │
 *      │ ▾ Sessions · 47                │
 *      │   …                            │
 *      ╰────────────────────────────────╯
 *      ╭────────────────────────────────╮
 *      │ ↓ Artemis 0.4.0 is available ✕ │  ← this
 *      │ [ Update now ]                 │
 *      ╰────────────────────────────────╯
 *
 * ## Why a second card rather than the row that used to be here
 *
 * The sidebar's last row was `Start somewhere else` — a project switcher that
 * started a blank session in another directory. Every project is in the list
 * above it now, and the chip over the composer already offers recent folders and
 * a folder picker, so the row's remaining job was covered twice over while it
 * held the most permanent piece of furniture in the card.
 *
 * What is worth a permanent spot there is nothing at all, most of the time. So
 * the foot of the sidebar is empty until the updater has something to say, and
 * then it is a card: separate from the session card, the width of it, sitting on
 * the same background. A card can carry a sentence and an action without either
 * being cramped into row height, and when it appears the shape of the sidebar
 * changing is itself the notice.
 *
 * ## Why not the strip under the header
 *
 * That is where this used to live, and it is still the fallback when the sidebar
 * is hidden — see `UpdateBanner`. But a full-window strip pushes the header,
 * both transcripts and every composer down by its own height the moment it
 * appears, which is a lot of the window rearranging itself to report something
 * that is not urgent and cannot be acted on wrongly. The card grows into space
 * the session list gives up, so nothing outside the sidebar moves.
 *
 * ## What each phase renders
 *
 *  - `idle`       → nothing.
 *  - `available`  → the offer: version, install, dismiss.
 *  - `working`    → what it is doing, how far in, and "keep Artemis open". No
 *                   actions; there is nothing to decide and nothing safely
 *                   cancellable. The bar is the point: the archive is ~196MB,
 *                   so this phase is minutes long, and a spinner alone had a
 *                   user clicking Update three times because nothing on screen
 *                   distinguished a download from a hang.
 *  - `ready`      → the installed version, waiting on the one decision that is
 *                   the user's alone: restart now, or keep working and pick it
 *                   up on the next launch. Nothing here happens on a timer, and
 *                   there is no dismiss — quitting normally is the other way to
 *                   take it, so nothing is lost by leaving the card up.
 *  - `restarting` → a spinner, one line, gone in a moment.
 *  - `error`      → what happened, the manual path when main supplied one, and a
 *                   dismiss that silences this version.
 */

import type { ReactElement } from 'react';
import {
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';

import { updatePercent, type UpdateProgress, type UpdateState } from '@rx-artemis/protocol';

import {
  dismissUpdate,
  installUpdate,
  restartForUpdate,
  updaterChannels,
  useUpdateState,
} from '../hooks/useUpdateState';
import { IconButton } from './disabled-reason';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

export function UpdateCard(): ReactElement | null {
  const state = useUpdateState();

  if (state.phase === 'idle') return null;

  const version = state.version ?? '';
  const dismissable = state.phase === 'available' || state.phase === 'error';

  return (
    <div
      role="status"
      /*
       * The session card's chrome exactly — same radius, border, fill, shadow
       * and ring — because this is a sibling of it and not a panel inside it.
       * `mt-2` matches the aside's padding, so the gutter between the two cards
       * is the gutter around them.
       *
       * `shrink-0` is not decoration: the card above is `flex-1`, and without
       * this the sentence would be squeezed instead of the session list.
       */
      className="mt-2 shrink-0 rounded-md border border-line bg-panel"
    >
      <div className="flex flex-col gap-2 p-2.5">
        <div className="flex items-start gap-2">
          <Phase phase={state.phase} />

          <div className="min-w-0 flex-1 text-2xs leading-snug text-ink">
            {state.phase === 'available' && (
              <>
                <span className="font-medium">Artemis {version}</span> is available.
              </>
            )}
            {state.phase === 'working' && (
              <>{workingLine(state.progress, version)}… keep Artemis open.</>
            )}
            {state.phase === 'ready' && (
              <>
                <span className="font-medium">Artemis {version}</span> is installed. Restart to
                finish.
              </>
            )}
            {state.phase === 'restarting' && <>Restarting into {version}…</>}
            {state.phase === 'error' && (
              <span className="text-ink-muted">
                {state.message ?? 'The update could not be installed.'}
              </span>
            )}
          </div>

          {dismissable && updaterChannels() !== null && (
            <IconButton
              label="Dismiss"
              size="icon-xs"
              className="-mr-1 -mt-0.5 shrink-0 text-ink-faint"
              onClick={() => dismissUpdate(version)}
            >
              <XIcon />
            </IconButton>
          )}
        </div>

        {/*
          The bar, and only while there is something to be partway through.

          Determinate when the step can count and indeterminate when it cannot
          — see `updatePercent`. The byte line sits under it rather than in the
          sentence above because it changes ten times a second: text that
          rewrites itself mid-sentence is harder to read than a number in a
          place the eye can rest on.
        */}
        {state.phase === 'working' && (
          <div className="flex flex-col gap-1">
            <Progress
              value={updatePercent(state.progress) ?? undefined}
              aria-label={workingLine(state.progress, version)}
              className={updatePercent(state.progress) === null ? 'animate-pulse' : undefined}
            />
            {byteLine(state.progress) !== null && (
              <div className="text-right font-mono text-3xs text-ink-faint tabular-nums">
                {byteLine(state.progress)}
              </div>
            )}
          </div>
        )}

        {/*
          One action, full width, and only for the two phases that have one. The
          rest are reports: a download in flight has nothing to decide, and a
          failure's only route out is the release page below.

          `secondary` rather than the filled default, in a card whose whole
          existence is already the notice. New session is the one primary button
          in this column — a second one the same colour two hundred pixels below
          it reads as an equal, and an update is not what the app is for.
        */}
        {state.phase === 'available' && (
          <Button
            size="xs"
            variant="secondary"
            onClick={installUpdate}
            className="w-full justify-center"
          >
            Update now
          </Button>
        )}

        {state.phase === 'ready' && (
          <Button
            size="xs"
            variant="secondary"
            onClick={restartForUpdate}
            className="w-full justify-center"
          >
            Restart now
          </Button>
        )}

        {state.phase === 'error' && state.releaseUrl !== null && (
          // A plain anchor: the window-open guard in `main/security.ts` routes
          // external URLs to the system browser and refuses to navigate this
          // window, so this is already the safe way out.
          <Button asChild size="xs" variant="outline" className="w-full justify-center">
            <a href={state.releaseUrl} target="_blank" rel="noreferrer">
              Open releases page
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The whole of what the sentence says while an install runs: the step, and the
 * version it is working on.
 *
 * `checking` is why this is a function rather than a label and a version set
 * side by side. It runs *before* the version is settled — its entire job is to
 * find out whether the offer has been superseded since the card appeared — so
 * naming one there would name the one thing that is about to change, and then
 * change it a second later.
 */
function workingLine(progress: UpdateProgress | null, version: string): string {
  if (progress?.step === 'checking') return 'Checking for the latest version';
  return `${stepLabel(progress)} ${version}`.trim();
}

/**
 * What to call the step, in the sentence.
 *
 * Present participles, so the line reads as something in progress rather than
 * as a label: "Downloading 1.5.0… keep Artemis open." An absent reading falls
 * back to the old wording, which is still true of every step.
 */
function stepLabel(progress: UpdateProgress | null): string {
  switch (progress?.step) {
    case 'checking':
      // Unreachable in practice: `workingLine` answers for this step before it
      // reaches here, because the step has no version to name. Kept so the
      // switch covers the union rather than falling through to "Updating to".
      return 'Checking for';
    case 'downloading':
      return 'Downloading';
    case 'verifying':
      return 'Verifying';
    case 'unpacking':
      return 'Unpacking';
    case 'installing':
      return 'Installing';
    default:
      return 'Updating to';
  }
}

/** `84.2 MB of 196.0 MB`, or null when this step cannot count. */
function byteLine(progress: UpdateProgress | null): string | null {
  if (progress?.transferred == null) return null;
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return progress.total === null
    ? mb(progress.transferred)
    : `${mb(progress.transferred)} of ${mb(progress.total)}`;
}

/** The phase's icon: a state's worth of colour, in 14 pixels. */
function Phase({ phase }: { readonly phase: UpdateState['phase'] }): ReactElement {
  if (phase === 'error') {
    return <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0 text-signal" />;
  }
  if (phase === 'available') {
    return <DownloadIcon aria-hidden className="mt-px size-3.5 shrink-0 text-beam" />;
  }
  if (phase === 'ready') {
    return <RefreshCwIcon aria-hidden className="mt-px size-3.5 shrink-0 text-beam" />;
  }
  return (
    <LoaderCircleIcon aria-hidden className="mt-px size-3.5 shrink-0 animate-spin text-beam" />
  );
}
