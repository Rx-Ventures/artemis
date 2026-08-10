/**
 * What the transcript shows before anything has happened.
 *
 * Two jobs, and the second matters more: say what to press, and say out loud
 * whatever is missing — no profile, no working directory — instead of letting
 * the user discover it by typing a prompt and getting an error back.
 *
 * Both blockers are fixable from here. The sidebar also carries a directory
 * control, and that duplication is deliberate: this is where the eye already
 * is when the app has nothing to show, and "you cannot run yet" is not a
 * message to pair with "go and find the control yourself".
 */

import { useState, type ReactElement } from 'react';
import { FolderIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';

import { keyLabel } from '../hooks/useHotkeys';
import { activeProviderLabel, setScreen, useApp } from '../state/store';
import { WorkingDirectoryDialog } from './WorkingDirectory';
import { LogoMark } from './logo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

export function EmptyState(): ReactElement {
  const profile = useApp((s) => s.profiles.find((p) => p.id === s.activeProfileId));
  const cwd = useApp((s) => s.cwd);
  const provider = useApp(activeProviderLabel);
  const resuming = useApp((s) => s.resumeSessionId);
  const [directoryOpen, setDirectoryOpen] = useState(false);

  const missingProfile = profile === undefined;
  const missingCwd = cwd.trim().length === 0;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-8 text-center">
      <LogoMark size={34} className="text-brass/70" />
      <h1 className="mt-3 font-sans text-lg font-semibold tracking-tight text-ink">Libra</h1>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-ink-muted">
        A desk for agentic coding CLIs. Currently pointed at{' '}
        <span className="font-mono text-ink">{provider}</span>
        {profile ? (
          <>
            {' '}
            via <span className="font-mono text-ink">{profile.label}</span>
          </>
        ) : null}
        .
      </p>

      {missingProfile || missingCwd ? (
        <Alert className="mt-4 max-w-md border-amber/35 bg-amber/5 text-left text-amber">
          <TriangleAlertIcon />
          <AlertTitle className="text-2xs">Not ready to run</AlertTitle>
          <AlertDescription className="text-2xs text-amber/85">
            {missingProfile ? (
              <p className="flex items-center gap-1.5">
                No profile — a run needs credentials.
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto gap-1 p-0 text-2xs text-brass"
                  onClick={() => setScreen('profiles')}
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
                  className="h-auto gap-1 p-0 text-2xs text-brass"
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
        <p className="mt-4 font-mono text-2xs text-ink-faint">
          the next prompt continues session {resuming.slice(0, 8)}…
        </p>
      ) : null}

      <dl className="mt-8 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-left">
        <Hint combo="enter" text="send the prompt" />
        <Hint combo="shift+enter" text="new line" />
        <Hint combo="mod+k" text="commands, sessions, settings" />
        <Hint combo="escape" text="stop the run, or deny a prompt" />
        <Hint combo="mod+n" text="new session" />
        <Hint combo="mod+b" text="show or hide the sidebar" />
        <Hint combo="mod+i" text="run details" />
      </dl>

      <WorkingDirectoryDialog open={directoryOpen} onOpenChange={setDirectoryOpen} />
    </div>
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
