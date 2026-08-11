/**
 * Choosing the directory the agent works in.
 * ============================================================================
 *
 * Two ways in, and both are always present:
 *
 *  - **Browse…** opens the host's own folder chooser over IPC. That channel is
 *    feature-detected (`lib/extensions.ts`) because it is being added by the
 *    process that owns the preload bridge. When it is absent the button is
 *    rendered *disabled with the reason*, following the same rule every
 *    capability-gated control in this app follows — never silently missing.
 *  - **A path field**, which validates absoluteness before submitting. The
 *    check mirrors `node:path.isAbsolute` per platform, which is exactly what
 *    the main process enforces, so a path this field accepts is one the backend
 *    will accept too.
 *
 * Failures are shown verbatim. When the picker refuses, its own sentence is
 * what appears — "could not set the working directory" would throw away the
 * only useful part of the failure.
 *
 * ## Committing here may end the current session
 *
 * The directory is the session's, not the window's, so moving it starts a fresh
 * session rather than pointing the current one somewhere its transcript was
 * never written — `setCwd` in the store owns that rule and every route in here
 * goes through it. The copy says so before the click rather than leaving the
 * user to infer it from a transcript that just emptied.
 *
 * Reached from the status line, the command palette and the empty state. The
 * sidebar used to be a fourth; see the note at the foot of this file.
 */

import { useState, type ReactElement } from 'react';
import { FolderIcon, FolderSearchIcon, GitBranchIcon, TriangleAlertIcon } from 'lucide-react';

import { hasNativeDirectoryPicker, NO_PICKER_REASON } from '../lib/extensions';
import { absolutePathHint, isAbsolutePath, lastSegment } from '../lib/paths';
import { chooseWorkingDirectory, lastKnownBranch, setCwd, useApp } from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { ReasonButton } from './disabled-reason';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/* -------------------------------------------------------------------------- */
/* The chooser                                                                */
/* -------------------------------------------------------------------------- */

export interface DirectoryChooserProps {
  /** Called once a directory has actually been adopted. */
  readonly onDone?: () => void;
  readonly onCancel?: () => void;
  readonly autoFocus?: boolean;
}

export function DirectoryChooser({
  onDone,
  onCancel,
  autoFocus = true,
}: DirectoryChooserProps): ReactElement {
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const [draft, setDraft] = useState(cwd);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const native = hasNativeDirectoryPicker();
  const typed = draft.trim();
  const valid = isAbsolutePath(typed, platform);

  const browse = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const choice = await chooseWorkingDirectory(pane);
    setBusy(false);
    if (choice.status === 'chosen') {
      setDraft(choice.path);
      onDone?.();
      return;
    }
    // Cancelling is a decision, not a failure. Say nothing.
    if (choice.status === 'cancelled') return;
    setError(choice.message);
  };

  const commit = (): void => {
    if (typed.length === 0) {
      setError('Enter a path, or use Browse to pick one.');
      return;
    }
    if (!valid) {
      setError(absolutePathHint(platform));
      return;
    }
    setCwd(typed, pane);
    setError(null);
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ReasonButton
          size="sm"
          variant="secondary"
          onClick={() => void browse()}
          disabled={!native || busy}
          disabledReason={native ? undefined : NO_PICKER_REASON}
          tooltip="Open your system's folder chooser."
        >
          <FolderSearchIcon />
          {busy ? 'Choosing…' : 'Browse…'}
        </ReasonButton>
        <span className="text-2xs text-ink-faint">
          {native ? 'or type a path' : 'type or paste a path'}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="artemis-cwd" className="text-2xs tracking-wider text-ink-faint uppercase">
          Working directory
        </Label>
        <Input
          id="artemis-cwd"
          autoFocus={autoFocus}
          value={draft}
          spellCheck={false}
          aria-invalid={typed.length > 0 && !valid}
          aria-describedby="artemis-cwd-hint"
          placeholder={platform === 'win32' ? 'C:\\Users\\you\\project' : '/absolute/path/to/project'}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          className="font-mono text-xs md:text-xs"
        />
        <p id="artemis-cwd-hint" className="text-2xs leading-snug text-ink-faint">
          {absolutePathHint(platform)} Moving it starts a new session — a session only resumes in
          the directory it was created in.
        </p>
      </div>

      {error ? (
        <p className="flex items-start gap-1.5 text-2xs leading-snug text-signal">
          <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
          {/* The backend's own words, not a paraphrase. */}
          <span>{error}</span>
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={commit} disabled={typed.length === 0}>
          Use this directory
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                     */
/* -------------------------------------------------------------------------- */

export function WorkingDirectoryDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">Set working directory</DialogTitle>
          <DialogDescription className="text-2xs">
            The agent runs here, and this is the project its sessions are recorded under. Moving it
            starts a new session.
          </DialogDescription>
        </DialogHeader>
        <DirectoryChooser onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* The chip                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The directory control, as a chip above the composer.
 *
 * ## It names the folder rather than locating it
 *
 * The label is the *last segment* only — `libra`, not `~/dev/work/libra`. A
 * path is what you need to tell two folders of the same name apart, which is
 * not a question anyone asks of the directory they are already sitting in; the
 * name is what answers "am I in the right place", which is what this chip is
 * for. The full path is one hover away, and the dialog behind it states it
 * outright.
 *
 * That also makes the control a stable, readable width instead of one that
 * grows with how deeply nested the project happens to be — which is what let it
 * leave the status line's right-hand cluster, where it was competing for room
 * with the plan meter.
 *
 * The branch rides along, and has to: it is a last-known value read off session
 * history for this directory rather than a live read, and dropping it while
 * moving the control would be removing information rather than relocating it.
 * See `lastKnownBranch`.
 *
 * A control, not a readout: it opens the same chooser the palette and the empty
 * state use. Committing may end the current session — `setCwd` owns that rule,
 * and the dialog says so before the click.
 */
export function WorkingDirectoryChip(): ReactElement {
  const cwd = usePane((s) => s.cwd);
  const workspace = usePane((s) => s.workspace);
  const branch = usePane(lastKnownBranch);
  const [open, setOpen] = useState(false);

  const unset = cwd.trim().length === 0;
  /*
   * `workspace.name` is the directory's own last segment, resolved by the main
   * process; `lastSegment` covers the moment before that reply lands and any
   * build without the `describe` channel.
   *
   * Deliberately not `repoName`, which the sidebar's own label does prefer. The
   * question here is which folder the agent will run in, and inside a monorepo
   * the repository's name answers a different one — it would read `libra` while
   * the agent worked in `packages/core`.
   */
  const name = unset ? null : (workspace?.name ?? lastSegment(cwd));

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setOpen(true)}
            aria-label="Working directory — change it"
            // Faint either way. "No directory" is the same absent-value
            // placeholder the header and the sidebar show, and colouring one of
            // the three left this control disagreeing with them about how
            // alarming an unconfigured app is.
            className="h-5 min-w-0 gap-1.5 px-1.5 font-mono text-2xs font-normal text-ink-faint"
          >
            <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
            <span className={cn('truncate', !unset && 'text-ink-muted')}>
              {name ?? 'no directory'}
            </span>
            {branch ? (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{branch}</span>
              </span>
            ) : null}
          </Button>
        </TooltipTrigger>
        {/*
          `flex-col items-start`, because `TooltipContent` is a flex *row* with
          centred items — two children in it become two columns, which is how
          this tooltip spent a while rendering the path and the branch note side
          by side, each half the width and neither reading as a sentence.

          The full path lives here now that the chip shows only the folder name.
          That makes the hover load-bearing rather than merely convenient, which
          is the trade this chip accepts.
        */}
        <TooltipContent side="top" align="start" className="max-w-sm flex-col items-start gap-1">
          {unset ? (
            <span>
              No working directory set — the agent needs an absolute path to work in. Click to
              choose one.
            </span>
          ) : (
            <span className="font-mono break-all">{cwd}</span>
          )}
          {branch ? (
            <span className="text-ink-faint">
              Branch “{branch}” is the last one recorded here, so it may be stale.
            </span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <WorkingDirectoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/*
 * REMOVED: `WorkingDirectoryButton`.
 *
 * The sidebar's directory row — a folder icon and the shortened path, under New
 * session. It presented the directory as a standing property of the window that
 * the next session would inherit, which is the opposite of what it is: the
 * directory belongs to the session, and changing it ends that session rather
 * than moving it (`setCwd` in the store).
 *
 * `WorkingDirectoryChip` above is the single trigger now. It lived on the status
 * line until it moved up to sit with the composer; either way the rule that
 * removed this button holds — one trigger for one value.
 */
