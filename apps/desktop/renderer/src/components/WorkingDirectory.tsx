/**
 * Choosing the directory the agent works in.
 * ============================================================================
 *
 * The control above the composer is a **menu of folders already worked in**,
 * because that is the choice being made nearly every time — see
 * `WorkingDirectoryChip`. What follows is the dialog behind its last row, for
 * the case the list cannot answer: a folder the app has never been in.
 *
 * Two ways in from there, and both are always present:
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

import { useMemo, useRef, useState, type ReactElement } from 'react';
import {
  FolderIcon,
  FolderPlusIcon,
  FolderSearchIcon,
  GitBranchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';

import { hasNativeDirectoryPicker, NO_PICKER_REASON } from '../lib/extensions';
import {
  absolutePathHint,
  inferHomeDirectory,
  isAbsolutePath,
  lastSegment,
  shortenPath,
  sortFoldersByName,
  type Platform,
} from '../lib/paths';
import {
  addSessionDirectory,
  chooseWorkingDirectory,
  lastKnownBranch,
  removeSessionDirectory,
  setCwd,
  useApp,
} from '../state/store';
import { usePane, usePaneRef } from '../state/paneContext';
import { useAutoIncludedBankDirectories } from '../hooks/useMemoryBanks';
import { ReasonButton } from './disabled-reason';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
        <Label htmlFor="artemis-cwd" className="chrome-label text-ink-faint">
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

      <AdditionalFolders />
    </div>
  );
}

/**
 * Folders the next run may read, beyond the working directory.
 *
 * Separate from the commit above, and deliberately so: adding or removing one
 * takes effect at once and does *not* move the session, because these widen
 * where the next run looks rather than where this conversation lives. The
 * protocol has carried {@link RunInput.additionalDirectories} all along; this is
 * the first surface that fills it in, so a folder outside the project — a bank,
 * a sibling checkout — can be reached without repointing the whole session at it.
 *
 * The team memory banks arrive by the same field but are merged in the main
 * process (see `main/engine.ts`), so they are shown here read-only: the point is
 * to make visible that a bank kept outside the project is already attached, not
 * to offer to detach it from a single run.
 */
function AdditionalFolders(): ReactElement {
  const pane = usePaneRef();
  const platform = useApp((s) => s.platform);
  const folders = usePane((s) => s.additionalDirectories);
  const bankFolders = useAutoIncludedBankDirectories();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = hasNativeDirectoryPicker();

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const choice = await addSessionDirectory(pane);
    setBusy(false);
    // Cancelling is a decision, not a failure. Only the picker's own refusals
    // surface, in its own words — the same rule the working-directory field uses.
    if (choice.status === 'failed' || choice.status === 'unavailable') setError(choice.message);
  };

  const empty = folders.length === 0 && bankFolders.length === 0;

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="chrome-label text-ink-faint">Additional folders</Label>
        <ReasonButton
          size="xs"
          variant="ghost"
          onClick={() => void add()}
          disabled={!native || busy}
          disabledReason={native ? undefined : NO_PICKER_REASON}
          tooltip="Add a folder the agent may read, beyond the working directory."
        >
          <FolderPlusIcon />
          {busy ? 'Choosing…' : 'Add folder…'}
        </ReasonButton>
      </div>

      <p className="text-2xs leading-snug text-ink-faint">
        Read-only folders the next run may open in addition to the working directory. Adding one does
        not start a new session.
      </p>

      {empty ? (
        <p className="text-2xs text-ink-faint">
          None. A run reaches only the working directory.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {folders.map((folder) => (
            <li key={folder} className="flex items-center gap-2" title={folder}>
              <FolderIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
                {shortenPath(folder, { platform, max: 40 })}
              </span>
              <button
                type="button"
                onClick={() => removeSessionDirectory(folder, pane)}
                aria-label={`Remove ${folder}`}
                className="shrink-0 rounded-sm p-0.5 text-ink-faint transition-colors hover:text-signal"
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
          {/*
            The banks, read-only. They are attached by the engine whenever the
            master switch is on, so a remove button here would promise something
            this surface cannot deliver — the folder would be back on the next
            run. The caption is what makes "already attached" legible.
          */}
          {bankFolders.map((folder) => (
            <li key={folder} className="flex items-center gap-2" title={folder}>
              <FolderIcon className="size-3 shrink-0 text-ink-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
                {shortenPath(folder, { platform, max: 40 })}
              </span>
              <span className="shrink-0 text-2xs text-ink-faint">memory bank</span>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="flex items-start gap-1.5 text-2xs leading-snug text-signal">
          <TriangleAlertIcon className="mt-px size-3 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
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
 * ## It opens a list of folders, not a file dialog
 *
 * Clicking it drops a menu of the folders this window has worked in — see
 * `AppState.recentFolders` — with the current one ticked. Moving between two or
 * three projects is the thing this control is actually asked to do all day, and
 * the version that went straight to the host's file dialog made the app's own
 * memory unreachable: the OS chooser has no idea which folders Artemis has been
 * in, so every hop was a navigation through a tree the app could have simply
 * listed.
 *
 * The dialog is one row further down, under **Add folder…**, and it is the same
 * dialog it always was — Browse plus a path field. Nothing was replaced; a
 * shortcut was put in front of it for the case that is common.
 *
 * Rows are alphabetical, which is a different order from the one the list is
 * stored in. That note lives on `AppState.recentFolders`; the short version is
 * that a menu which reorders itself around what you last did cannot be learned.
 *
 * Choosing a row is a `setCwd`, so it inherits that action's rules whole: moving
 * ends the selected session, and a live run refuses with a banner rather than
 * throwing the run away. The menu does not restate either — this is the same
 * commitment the dialog behind it has always made, and it is made in the same
 * place.
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
  const pane = usePaneRef();
  const cwd = usePane((s) => s.cwd);
  const workspace = usePane((s) => s.workspace);
  const branch = usePane(lastKnownBranch);
  const platform = useApp((s) => s.platform);
  const recentFolders = useApp((s) => s.recentFolders);
  const [open, setOpen] = useState(false);

  const folders = useMemo(() => sortFoldersByName(recentFolders), [recentFolders]);
  /*
   * Home is inferred from the folders themselves, which is exactly what
   * `inferHomeDirectory` is for — the renderer has no `$HOME`. The current
   * directory joins the sample even when it has been forgotten from the list,
   * because a one-entry menu still wants its `~`.
   */
  const home = useMemo(
    () => inferHomeDirectory([...folders, cwd], platform),
    [folders, cwd, platform],
  );

  /*
   * Set while a menu item is opening the dialog.
   *
   * Radix returns focus to the trigger when a menu closes, which lands *after*
   * the dialog has mounted and taken focus — so without this the chip would
   * steal focus back and the path field would open unfocused. Read and cleared
   * by `onCloseAutoFocus` below.
   */
  const toDialog = useRef(false);

  const unset = cwd.trim().length === 0;
  /*
   * `workspace.name` is the directory's own last segment, resolved by the main
   * process; `lastSegment` covers the moment before that reply lands and any
   * build without the `describe` channel.
   *
   * Deliberately not the repository, which is what the sidebar's group headings
   * name. The question here is which folder the agent will run in, and the
   * repository answers a different one — it would read `libra` while the agent
   * worked in `packages/core`, and `libra` again for a worktree split off from
   * it, which is precisely the pair this chip exists to tell apart.
   */
  const name = unset ? null : (workspace?.name ?? lastSegment(cwd));

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                aria-label="Working directory — change it"
                // Faint either way. "No directory" is the same absent-value
                // placeholder the header and the sidebar show, and colouring one
                // of the three left this control disagreeing with them about how
                // alarming an unconfigured app is.
                //
                // No resting fill, unlike the status line's chips below the
                // field: 7D `.wd` is quiet text sitting *above* the composer
                // card, a heading for what follows rather than one more setting
                // on it, and a chip here would put three filled rows in a
                // stack. The wash arrives on hover and stays while the menu is
                // open, which is the whole of the chrome this control needs.
                // `dark:hover:` is spelled out because the ghost variant's own
                // `dark:hover:bg-muted/50` outranks an unscoped override.
                // The path stays monospaced — it is a machine's string, and the
                // branch beside it is read off session history.
                className="h-[22px] min-w-0 gap-1.5 rounded-md px-2 font-mono text-2xs font-normal text-ink-faint hover:bg-wash aria-expanded:bg-wash dark:hover:bg-wash"
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
            </DropdownMenuTrigger>
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

        {/*
          Wider than the trigger, which is a chip. The default content width is
          the trigger's, and paths do not fit in it.
        */}
        <DropdownMenuContent
          align="start"
          side="top"
          className="w-72 max-w-[min(18rem,90vw)]"
          onCloseAutoFocus={(event) => {
            if (!toDialog.current) return;
            toDialog.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuLabel className="text-2xs text-ink-faint">Recent folders</DropdownMenuLabel>

          {folders.length === 0 ? (
            <p className="px-2 py-1.5 text-2xs leading-snug text-ink-faint">
              No folders remembered yet. The one you work in next appears here.
            </p>
          ) : (
            <DropdownMenuRadioGroup value={cwd} onValueChange={(next) => setCwd(next, pane)}>
              {folders.map((folder) => (
                <FolderItem key={folder} path={folder} home={home} platform={platform} />
              ))}
            </DropdownMenuRadioGroup>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-2xs"
            onSelect={() => {
              toDialog.current = true;
              setOpen(true);
            }}
          >
            <FolderSearchIcon className="size-3" />
            Add folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkingDirectoryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * One folder in the menu: its name, and the path under it.
 *
 * Both, unlike the chip — the chip answers "am I in the right place" about a
 * directory you are already in, whereas this is a *choice between* directories,
 * and two checkouts of the same repository are the case where the name alone
 * cannot be chosen between. The path is shortened for width and carried whole in
 * the `title`, which is the rule every shortened path in the app follows.
 */
function FolderItem({
  path,
  home,
  platform,
}: {
  readonly path: string;
  readonly home: string | undefined;
  readonly platform: Platform;
}): ReactElement {
  return (
    <DropdownMenuRadioItem value={path} className="text-xs" title={path}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ink">{lastSegment(path)}</span>
        <span className="truncate font-mono text-2xs text-ink-faint">
          {shortenPath(path, { home, platform, max: 34 })}
        </span>
      </span>
    </DropdownMenuRadioItem>
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
