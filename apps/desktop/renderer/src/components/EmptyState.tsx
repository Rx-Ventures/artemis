/**
 * What the transcript shows before anything has happened.
 * ============================================================================
 *
 * Two jobs, and the second matters more: say what to press, and say out loud
 * whatever is missing — no profile, no working directory — instead of letting
 * the user discover it by typing a prompt and getting an error back.
 *
 * Both blockers are fixable from here, which matters more than it used to. The
 * directory now has exactly one other control — the composer's chip, because the
 * directory belongs to the session rather than to the window — and "you cannot
 * run yet" is not a message to pair with "go and find the control yourself".
 * So this offers the same dialog rather than pointing at a bar.
 *
 * ## Why it is built on `Empty` rather than a bare centred div
 *
 * It occupies the same column the transcript will fill, and the transcript is
 * now a stack of bubbles with generous vertical rhythm. `Empty` gives the
 * identical centred, `text-balance`, gap-driven block the rest of the app's
 * empty surfaces use, so the first prompt does not visibly change the shape of
 * the page — it just replaces one thing in the middle of the column with
 * another. The structure also puts the mark, the title and the sentence into
 * one labelled header group, which is what makes the whole thing announce as a
 * single unit rather than as four loose paragraphs.
 *
 * ## The legend is a promise, so it has to be kept
 *
 * This is the only place in the app that enumerates the keyboard shortcuts, and
 * a legend that lists a binding the app no longer has is worse than no legend
 * at all. It is written by hand rather than generated because the hotkey map in
 * `App.tsx` is a map of *handlers*, with no room for the wording — so when a
 * binding changes there, this list is the other half of the change. Every row
 * below has a counterpart in `App.tsx`'s `useHotkeys` call, except `enter` and
 * `shift+enter`, which the composer handles itself.
 *
 * ## It reads in two columns, and the columns answer to the pane
 *
 * Console's `.ebox` sets the legend in a `1fr 1fr` grid, which is what stops
 * eight bindings from running down the page as a tall thin ladder under a
 * centred title. A single column reads as a list of instructions; two read as
 * a card of reference, which is what this is.
 *
 * The breakpoint is a *container* query, not a viewport one, and that is the
 * whole reason it is correct. This component renders inside a pane, and a
 * window split four ways is still one wide viewport — a `lg:` variant would
 * put two columns into a 300px column and wrap every label. `@container` on
 * the root asks the only question that matters: is there room here.
 *
 * ## The mark is filled
 *
 * A beam-filled tile with the bow in `--beam-ink`, rather than the bare
 * outline in `--beam-text/70` that stood here before. `logo.tsx` documents
 * both readings — "`--beam-text` beside text, `--beam-ink` on a beam fill" —
 * and this is the second one. It is the one saturated object on an otherwise
 * washed page, which is the job the mockup gives it: the eye lands there, then
 * on the sentence, then on the legend.
 */

import { useState, type ReactElement } from 'react';
import { FolderIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { activeProviderLabel, openSettings } from '../state/store';
import { usePane } from '../state/paneContext';
import { WorkingDirectoryDialog } from './WorkingDirectory';
import { LogoMark } from './logo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Kbd } from '@/components/ui/kbd';

export function EmptyState(): ReactElement {
  const profile = usePane((s) => s.profiles.find((p) => p.id === s.activeProfileId));
  const cwd = usePane((s) => s.cwd);
  const provider = usePane(activeProviderLabel);
  const resuming = usePane((s) => s.resumeSessionId);
  const [directoryOpen, setDirectoryOpen] = useState(false);

  const missingProfile = profile === undefined;
  const missingCwd = cwd.trim().length === 0;

  return (
    <Empty className="@container min-h-[60vh] gap-6 px-8 py-12">
      <EmptyHeader className="gap-1.5">
        {/*
          44px of beam with the bow in `--beam-ink` — Console's `.ebox .mark`,
          which is a 46px tile at a 12px radius. `rounded-xl` is 11.2px against
          the app's 8px `--radius`, which is that corner. The glyph is sized to
          sit inside the tile rather than to fill it: half the tile is the
          proportion the mockup draws.
        */}
        <EmptyMedia className="mb-4 size-11 rounded-xl bg-beam text-beam-ink">
          <LogoMark size={22} />
        </EmptyMedia>
        <EmptyTitle className="font-sans text-lg font-semibold tracking-tight text-ink">
          Artemis
        </EmptyTitle>
        <EmptyDescription className="text-xs leading-relaxed text-ink-muted">
          A desk for agentic coding CLIs. Currently pointed at{' '}
          <span className="font-mono text-ink">{provider}</span>
          {profile ? (
            <>
              {' '}
              via <span className="font-mono text-ink">{profile.label}</span>
            </>
          ) : null}
          .
        </EmptyDescription>
      </EmptyHeader>

      {/*
       * `max-w-lg`, wider than `EmptyContent`'s own `max-w-sm` and wider than
       * the `max-w-md` it was. Two reasons, and both are about wrapping. The
       * alert below carries two sentences and a control on one line each, and
       * at the narrow width they wrap into something that reads as four
       * warnings instead of two. And the legend is now two columns — 32rem is
       * Console's own `.ebox` width, which is what those columns were measured
       * against.
       */}
      <EmptyContent className="max-w-lg gap-4">
        {/*
         * A neutral card with a warning *icon*, not a warning-coloured card.
         *
         * Not the old argument, which `index.css` has since retired: amber is a
         * legitimate warning colour again now that the accent has left the warm
         * end and warning sits 128° away rather than 5°. The reason is simpler
         * and survives that change. A filled amber card is a large warm surface
         * wrapped around the two beam links that are the only things in it
         * worth clicking, and at that area the fill wins. The triangle says
         * "warning" in one glyph; the box does not need to repeat it at forty
         * times the size, in a hue that now fights the thing to click.
         */}
        {missingProfile || missingCwd ? (
          <Alert className="w-full border-hairline bg-wash text-left text-ink">
            <TriangleAlertIcon className="text-amber" />
            <AlertTitle className="text-2xs">Not ready to run</AlertTitle>
            <AlertDescription className="text-2xs text-ink-muted">
              {missingProfile ? (
                <p className="flex items-center gap-1.5">
                  No profile — a run needs credentials.
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto gap-1 p-0 text-2xs text-beam-text"
                    onClick={() => openSettings('profiles')}
                  >
                    <KeyRoundIcon className="size-3" />
                    Add one
                  </Button>
                </p>
              ) : null}
              {missingCwd ? (
                <p className="flex items-center gap-1.5">
                  No working directory.
                  <Button
                    variant="link"
                    size="xs"
                    className="h-auto gap-1 p-0 text-2xs text-beam-text"
                    onClick={() => setDirectoryOpen(true)}
                  >
                    <FolderIcon className="size-3" />
                    Set one
                  </Button>
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {resuming ? (
          <p className="font-mono text-2xs text-ink-faint">
            the next prompt continues session {resuming.slice(0, 8)}…
          </p>
        ) : null}

        {/*
          Two columns when the pane can hold them, one when it cannot. The
          `dt`/`dd` pairs flow in order, so a row of the grid is two bindings
          side by side and the reading order down the DOM is unchanged — which
          is what keeps this correct for a screen reader at either width.

          KEEP IN SYNC WITH `App.tsx`. Every row here has a counterpart in its
          `useHotkeys` call, except `enter` and `shift+enter`, which the
          composer handles itself. See "the legend is a promise" above: a
          legend listing a binding the app no longer has is worse than none.
        */}
        <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-left @lg:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] @lg:gap-x-5">
          <Hint combo="enter" text="send the prompt" />
          <Hint combo="shift+enter" text="new line" />
          <Hint combo="mod+k" text="commands, sessions, settings" />
          <Hint combo="escape" text="stop the run, or deny a prompt" />
          <Hint combo="mod+n" text="new session" />
          <Hint combo="mod+b" text="show or hide the sidebar" />
          <Hint combo="mod+," text="settings" />
          <Hint combo="mod+i" text="run details" />
        </dl>
      </EmptyContent>

      <WorkingDirectoryDialog open={directoryOpen} onOpenChange={setDirectoryOpen} />
    </Empty>
  );
}

/**
 * What a zero-row transcript shows while its conversation is still being read
 * in — a resume's history queued behind main's config-directory lock, or a
 * live run's replay still in flight.
 *
 * Deliberately almost nothing: no logo, no legend, no "press enter". Every one
 * of those says "nothing has happened here", and the one fact this state knows
 * is that something *has* — it just is not back from disk yet. So it says
 * that, in the same quiet mono voice as the resume hint above, and lets the
 * status line carry the liveness it already shows.
 *
 * Same `Empty` shell as {@link EmptyState}, so the wait and the rows that
 * replace it occupy the same centred column and the swap does not jump.
 */
export function ConversationLoading(): ReactElement {
  const conversation = usePane((s) => s.resumeSessionId ?? s.run?.sessionId ?? null);
  return (
    <Empty className="min-h-[60vh] gap-6 px-8 py-12">
      <p className="animate-pulse font-mono text-2xs text-ink-faint">
        {conversation
          ? `catching up with session ${conversation.slice(0, 8)}…`
          : 'catching up with this conversation…'}
      </p>
    </Empty>
  );
}

/**
 * One binding: the cap, then what it does.
 *
 * The cap is Console's `.legend b` — a wash, a 4px corner, no edge, and the
 * mono face because a key name is a literal string you type and not a label
 * someone wrote. `min-w-8` is what makes the caps a column rather than eight
 * different widths: `⌘⇧\` and `esc` set very different boxes, and the labels
 * beside them only line up if the caps do.
 *
 * `justify-self-start` rather than the `end` it was. Right-aligning worked
 * when there was one column and the caps hugged the labels across a gutter;
 * with two columns the caps have to start on the column's own rule or the
 * legend reads as four ragged stripes.
 */
function Hint({ combo, text }: { readonly combo: string; readonly text: string }): ReactElement {
  return (
    <>
      <dt className="justify-self-start">
        <Kbd className="min-w-8 rounded border-transparent bg-wash px-1.5 font-mono font-normal text-ink-muted">
          {keyLabel(combo)}
        </Kbd>
      </dt>
      <dd className="text-2xs text-ink-faint">{text}</dd>
    </>
  );
}
