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
 */

import { useState, type ReactElement } from 'react';
import { FolderOpenIcon, FolderSearchIcon, TriangleAlertIcon } from 'lucide-react';

import { hasNativeDirectoryPicker, NO_PICKER_REASON } from '../lib/extensions';
import { absolutePathHint, isAbsolutePath, shortenPath } from '../lib/paths';
import { chooseWorkingDirectory, setCwd, useApp } from '../state/store';
import { ReasonButton } from './disabled-reason';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

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
  const cwd = useApp((s) => s.cwd);
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
    const choice = await chooseWorkingDirectory();
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
    setCwd(typed);
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
          {absolutePathHint(platform)} Changing it re-lists this project’s sessions.
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
            The agent runs here, and this is the project its sessions are recorded under.
          </DialogDescription>
        </DialogHeader>
        <DirectoryChooser onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Trigger                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The sidebar's directory row: what is selected now, and a way to change it.
 *
 * Shows the shortened path with the full one on hover, and turns amber when
 * there is none — an unset working directory blocks every run, so it is stated
 * where the user will act on it rather than only in an error after they type a
 * prompt.
 */
export function WorkingDirectoryButton({ className }: { readonly className?: string }): ReactElement {
  const cwd = useApp((s) => s.cwd);
  const platform = useApp((s) => s.platform);
  const [open, setOpen] = useState(false);
  const unset = cwd.trim().length === 0;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title={unset ? 'No working directory set' : cwd}
        aria-label="Set working directory"
        className={cn(
          'h-6 w-full justify-start gap-1.5 px-1.5 font-mono text-2xs font-normal',
          unset ? 'text-amber' : 'text-ink-muted',
          className,
        )}
      >
        <FolderOpenIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {unset ? 'Set working directory' : shortenPath(cwd, { platform, max: 30 })}
        </span>
      </Button>
      <WorkingDirectoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
