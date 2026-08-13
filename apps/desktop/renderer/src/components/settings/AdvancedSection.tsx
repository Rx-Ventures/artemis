/**
 * Advanced.
 * ============================================================================
 *
 * The pane for arrangements Artemis supports but does not perform. Today that
 * is one: sharing a single `~/.claude` across every profile.
 *
 * ---------------------------------------------------------------------------
 * THE TOGGLE DOES NOT DO THE THING
 * ---------------------------------------------------------------------------
 *
 * Every other switch in this dialog changes the app. This one changes what this
 * pane offers, and the user changes the filesystem themselves by running a
 * script in a terminal.
 *
 * That reads like an unfinished feature and is not one. The operation moves
 * directories holding months of transcripts, across accounts, on paths Artemis
 * read out of a JSON file a user is allowed to edit by hand. A switch that did
 * it would make that a single click with nothing to read beforehand and no
 * record afterwards. A script can be reviewed before it runs, kept, re-run
 * outside Artemis, and — the case that decides it — run when Artemis itself is
 * the thing that is broken. So the switch records intent, `sharedClaudeConfig`
 * generates the shell, and the boundary between "what Artemis knows" and "what
 * Artemis did" stays where a user can see it.
 *
 * ---------------------------------------------------------------------------
 * THE WARNING IS A GATE, NOT A NOTICE
 * ---------------------------------------------------------------------------
 *
 * The script is not rendered until the user has been through the dialog and
 * accepted it. Not because reading a script is dangerous, but because this one
 * is easy to skim as boilerplate and act on: it is mostly `ln -s`, and the
 * consequence that actually surprises people — every profile shares one
 * `projects/`, so a session started on one account is listed and resumable
 * under all of them — is not visible in the diff of a symlink. The dialog says
 * that in words first, and the switch only moves if the user answers it.
 *
 * Cancelling leaves the switch down, which is why the confirmation writes the
 * store rather than the change handler.
 *
 * Turning it *off* is not gated. Nothing is at stake in asking for the undo,
 * and a confirmation there would be a dialog in front of the exit.
 */

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { CheckIcon, CopyIcon, KeyRoundIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';

import { CodeBlock } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import { setSharedClaudeConfig, useApp } from '../../state/store';
import { shortenPath } from '../../lib/paths';
import {
  BACKUP_SUFFIX,
  SHARED_DIRECTORIES,
  SHARED_FILES,
  buildSharedConfigScript,
  sharedConfigDirs,
  type SharedConfigMode,
} from '../../lib/sharedClaudeConfig';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';

/** The shared entries, as one line of prose. Built from the lists so the copy cannot drift from the script. */
const SHARED_SUMMARY = [...SHARED_DIRECTORIES, ...SHARED_FILES].join(', ');

export function AdvancedSection(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const on = useApp((s) => s.sharedClaudeConfig);
  const acknowledged = useApp((s) => s.sharedClaudeConfigAcknowledged);
  const [warning, setWarning] = useState(false);

  const dirs = useMemo(() => sharedConfigDirs(profiles), [profiles]);

  /*
   * Which script to show, and whether to show one at all.
   *
   * `null` is the un-met state: switch down, never accepted. Offering the undo
   * there would be an undo for something that never happened.
   */
  const mode: SharedConfigMode | null = on ? 'share' : acknowledged ? 'restore' : null;

  return (
    <SettingsPane
      title="Advanced"
      description="Arrangements Artemis will set up for you to run, but will not run itself."
    >
      <SettingsGroup label="Shared Claude config">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Share one ~/.claude across profiles</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Each profile gets its own config directory, which isolates the account and — as a
                side effect nobody asked for — everything else with it. This points{' '}
                <span className="font-mono text-ink-muted">{SHARED_SUMMARY}</span> at your own{' '}
                <span className="font-mono text-ink-muted">~/.claude</span>, so a skill written once
                is available to every account. Sign-in is deliberately left out of it.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-shared-claude-config"
                aria-label="Share one ~/.claude across profiles"
                checked={on}
                onCheckedChange={(next) => {
                  // On goes through the dialog, which writes the store if it is
                  // accepted. Off is immediate — see the file header.
                  if (next) setWarning(true);
                  else setSharedClaudeConfig(false);
                }}
              />
            </ItemActions>
          </Item>
        </ItemGroup>

        {mode === null ? (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Artemis does not link anything itself. Turn this on and it writes the script; you read
            it and run it.
          </p>
        ) : dirs.length === 0 ? (
          <Empty className="border border-dashed border-line py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle className="text-ink">No Claude profiles to name</EmptyTitle>
              <EmptyDescription className="text-2xs">
                {/* Deliberately not "nothing to link": in the undo direction
                    there may well be links out there, on profiles that have
                    since been deleted from Artemis. A script with no
                    directories in it is the honest thing to withhold, and
                    claiming there is nothing to undo would not be. */}
                A script needs directories to act on, and no Claude profile is registered. Add one
                in Profiles and it will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScriptBlock dirs={dirs} mode={mode} />
        )}
      </SettingsGroup>

      <WarningDialog
        open={warning}
        count={dirs.length}
        onOpenChange={setWarning}
        onAccept={() => {
          setSharedClaudeConfig(true);
          setWarning(false);
        }}
      />
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* The script                                                                 */
/* -------------------------------------------------------------------------- */

function ScriptBlock({
  dirs,
  mode,
}: {
  readonly dirs: readonly string[];
  readonly mode: SharedConfigMode;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  const script = useMemo(() => buildSharedConfigScript(dirs, mode), [dirs, mode]);

  const copy = useCallback(async (): Promise<void> => {
    // The tick waits for the write to resolve. Reporting success first is what
    // hid a denied clipboard permission the last time this pattern was written
    // — the button ticked, the paste that followed was whatever the user had
    // copied before, and the two were far enough apart to never be connected.
    try {
      await navigator.clipboard.writeText(script);
    } catch {
      toast('Could not copy the script', {
        description: 'Select the text above and copy it by hand.',
      });
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [script]);

  const sharing = mode === 'share';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-2xs leading-relaxed text-ink-muted">
          {sharing ? (
            <>
              Quit Artemis, run this in a terminal, then start it again. It covers{' '}
              {dirs.length === 1 ? 'one profile' : `${dirs.length} profiles`} and nothing else on
              your machine.
            </>
          ) : (
            <>
              This undoes it: the links go, and anything moved aside comes back. Safe to run even if
              you never ran the other one.
            </>
          )}
        </p>
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={sharing ? 'Copy the sharing script' : 'Copy the undo script'}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <ul className="flex flex-col gap-0.5">
        {dirs.map((dir) => (
          <li key={dir} className="font-mono text-2xs text-ink-faint" title={dir}>
            {shortenPath(dir, { max: 56 })}
          </li>
        ))}
      </ul>

      <CodeBlock text={script} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The warning                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the user is agreeing to.
 *
 * Three specific consequences rather than a general "this is advanced". Each
 * one is something a user could reasonably not have predicted from the phrase
 * "shared config", and the shared history is first because it is the one that
 * changes what the app appears to contain.
 */
function WarningDialog({
  open,
  count,
  onOpenChange,
  onAccept,
}: {
  readonly open: boolean;
  readonly count: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAccept: () => void;
}): ReactElement {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-amber/15 text-amber">
            <TriangleAlertIcon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>This one is rough around the edges</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-left">
              <p>
                Sharing a config directory is not something the Claude CLI was built for, and
                Artemis cannot promise every part of it behaves. Three things are worth knowing
                before you run the script:
              </p>
              <ul className="flex list-disc flex-col gap-1.5 pl-4">
                <li>
                  {/*
                    First, because it is the one consequence that is invisible
                    in the script and shows up immediately in the sidebar. No
                    longer a duplicate count — a session several profiles reach
                    is listed once — but a merged history is still not what
                    "shared config" sounds like, so it is said plainly.
                  */}
                  <span className="text-ink">Every account&rsquo;s history arrives in one list.</span>{' '}
                  <span className="font-mono">projects/</span> becomes one shared store, so a
                  conversation started on any of these accounts is listed — and resumable — from all
                  of them. Each appears once, under a single account label chosen from the profiles
                  that can reach it; opening it resumes on the account you are working in, not the
                  one on the label.
                </li>
                <li>
                  <span className="text-ink">Plugins and skills are shared wholesale.</span> One
                  that expects to be alone, or that keeps per-account state next to itself, will see
                  {/* `<= 1` rather than `=== 1`: the switch can be turned on
                      with no profiles registered, and "all 0 profiles" is
                      worse than dropping the number. */}
                  {count <= 1 ? ' every profile ' : ` all ${count} profiles `}
                  at once.
                </li>
                <li>
                  <span className="text-ink">Nothing is deleted, but things move.</span> Whatever is
                  already in a profile is renamed to{' '}
                  <span className="font-mono">…{BACKUP_SUFFIX}</span> before the link is made. The
                  undo script puts it back.
                </li>
                <li>
                  <span className="text-ink">Live state is shared too.</span>{' '}
                  <span className="font-mono">ide/</span> and{' '}
                  <span className="font-mono">session-env/</span> describe connections and
                  environments that belong to a running CLI, so run the script with Artemis closed.
                </li>
              </ul>
              <p>
                Sign-in is not shared:{' '}
                <span className="font-mono">.claude.json</span>,{' '}
                <span className="font-mono">settings.json</span>,{' '}
                <span className="font-mono">sessions/</span> and the stored credential stay per
                profile. Accounts remain separate accounts.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/*
            "Show me the script", not "Enable" — accepting this reveals text to
            read, and a button that promised to enable something would be
            describing work the user still has to do themselves.
          */}
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              onAccept();
            }}
          >
            Show me the script
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
