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
    <Empty className="min-h-[60vh] gap-6 px-8 py-12">
      <EmptyHeader className="gap-1.5">
        <EmptyMedia>
          <LogoMark size={34} className="text-beam-text/70" />
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
       * `max-w-md`, wider than `EmptyContent`'s own `max-w-sm`. The alert below
       * carries two sentences and a control on one line each, and at the
       * narrower width they wrap into something that reads as four warnings
       * instead of two.
       */}
      <EmptyContent className="max-w-md gap-4">
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
          <Alert className="w-full border-line bg-raised text-left text-ink">
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

        <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-left">
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

function Hint({ combo, text }: { readonly combo: string; readonly text: string }): ReactElement {
  return (
    <>
      <dt className="justify-self-end">
        <Kbd>{keyLabel(combo)}</Kbd>
      </dt>
      <dd className="text-2xs text-ink-faint">{text}</dd>
    </>
  );
}
