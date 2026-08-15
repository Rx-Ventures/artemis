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
 *
 * ---------------------------------------------------------------------------
 * TWO QUESTIONS, ANSWERED SEPARATELY
 * ---------------------------------------------------------------------------
 *
 * The switch says what the user asked for. The block under it says what is on
 * the disk, read over `sharedConfig.status`. They are never reconciled, because
 * the cases where they differ are the ones worth showing:
 *
 * | Switch | On disk    | Without the reading, the pane said                  |
 * |--------|------------|-----------------------------------------------------|
 * | on     | linked     | correct                                             |
 * | on     | not linked | sharing that never happened — script read, closed   |
 * | off    | linked     | isolation that is not real — prefs reset, or by hand|
 * | on     | *partly*   | correct-looking, and wrong                           |
 *
 * The fourth row is the one that actually happens: the script covers the
 * profiles that existed when it was generated, so a fifth account added next
 * month gets none of the links while the switch stays on and the pane keeps
 * listing every directory identically. That profile quietly has its own
 * `skills/` and its own history, and the failure is silent in the direction that
 * matters — the user believes a skill is available everywhere.
 *
 * The reading does not move the switch. It does decide *which script* is worth
 * offering, which is a different thing: a disk with links on it makes the undo
 * script relevant even to a user who never accepted the warning (a reset
 * preference file, a reinstall), and the narrow script exists because "cover the
 * two profiles that are actually unlinked" is a shorter thing to read than
 * "cover all five again".
 */

import { useMemo, useState, type ReactElement } from 'react';
import { CheckIcon, CopyIcon, KeyRoundIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

import type { SharedConfigDirStatus, SharedConfigStatus } from '@rx-artemis/protocol';

import { useCopy } from '@/hooks/useCopy';
import { CodeBlock, StatusDot, toneClasses, type Tone } from '../primitives';
import { ChoiceList, SettingsGroup, SettingsPane } from './pane';
import { setSharedClaudeConfig, useApp } from '../../state/store';
import { shortenPath } from '../../lib/paths';
import {
  useSharedConfigStatus,
  type SharedConfigReading,
} from '../../hooks/useSharedConfigStatus';
import {
  BACKUP_SUFFIX,
  SHARED_ENTRIES,
  SHARED_FILES,
  buildSharedConfigScript,
  dirsNeedingWork,
  entryGap,
  sharedConfigDirs,
  statusDisagrees,
  statusHasLinks,
  summarizeDir,
  type SharedConfigDirSummary,
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
import { cn } from '@/lib/utils';

/** The shared entries, as one line of prose. Built from the list so the copy cannot drift from the script. */
const SHARED_SUMMARY = SHARED_ENTRIES.join(', ');

export function AdvancedSection(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const on = useApp((s) => s.sharedClaudeConfig);
  const acknowledged = useApp((s) => s.sharedClaudeConfigAcknowledged);
  const [warning, setWarning] = useState(false);
  const reading = useSharedConfigStatus();

  const dirs = useMemo(() => sharedConfigDirs(profiles), [profiles]);

  /*
   * Which script to show, and whether to show one at all.
   *
   * `null` is the un-met state: switch down, never accepted, and — since the
   * pane learned to read the disk — nothing out there either. That last clause
   * is what makes the undo reachable for the case the acknowledgement cannot
   * cover: a preference file that was reset, or a fresh install on a machine
   * whose profiles are still linked from months ago. Offering an undo for
   * something that never happened is what this `null` still refuses; refusing it
   * for something that demonstrably did would be the same mistake in the other
   * direction.
   */
  const linked = reading.status !== null && statusHasLinks(reading.status);
  const mode: SharedConfigMode | null = on ? 'share' : acknowledged || linked ? 'restore' : null;

  /*
   * The status block is shown whenever a script is, and also in the one case
   * where there is no script to show but there is something to say: links on
   * disk under a switch that is down. It is deliberately *not* shown to a user
   * who has never met the feature and whose disk is untouched — nine `missing`
   * entries per profile is the ordinary state of such a machine, and reporting
   * it at length would turn a feature nobody enabled into a paragraph of
   * nothing-is-wrong.
   */
  const showStatus = dirs.length > 0 && (mode !== null || linked);

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

        {showStatus ? <StatusBlock dirs={dirs} reading={reading} intended={on} /> : null}

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
          <ScriptBlock dirs={dirs} mode={mode} status={reading.status} />
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
/* What is on disk                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The reading, one line per profile directory.
 *
 * The paths are listed from the *store*, not from the reading, and that ordering
 * is load-bearing: the pane's job is to say something about every profile the
 * script covers, so a directory the main process has not answered for yet shows
 * its path with the state column blank rather than vanishing until the read
 * lands. The reading is joined onto it by path.
 */
function StatusBlock({
  dirs,
  reading,
  intended,
}: {
  readonly dirs: readonly string[];
  readonly reading: SharedConfigReading;
  readonly intended: boolean;
}): ReactElement {
  const status = reading.status;

  const rows = useMemo(() => {
    const found = new Map<string, SharedConfigDirStatus>(
      (status?.dirs ?? []).map((dir) => [dir.dir, dir]),
    );
    return dirs.map((dir) => {
      const observed = found.get(dir) ?? null;
      return {
        dir,
        observed,
        summary: observed === null ? null : summarizeDir(observed, status?.rootMissing ?? []),
      };
    });
  }, [dirs, status]);

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-mono text-2xs tracking-[0.14em] text-ink-faint uppercase">On disk</h4>
        <Button
          size="xs"
          variant="ghost"
          className="-my-1 shrink-0 text-ink-faint"
          onClick={reading.refresh}
          disabled={reading.reading}
          aria-label="Re-read the links on disk"
        >
          <RefreshCwIcon />
          {reading.reading ? 'Reading' : 'Refresh'}
        </Button>
      </div>

      {/* Named once, up here, rather than repeated per row: every state below is
          a state *relative to* this directory, and a pane that showed states
          without saying what they were compared against would be asking to be
          taken on faith. The renderer cannot work it out — it has no home
          directory — so it comes back with the reading. */}
      <p className="text-2xs leading-relaxed text-ink-faint">
        {status === null ? (
          reading.error === null ? (
            'Reading the links in each profile directory.'
          ) : (
            <span className="text-signal">{reading.error}</span>
          )
        ) : (
          <>
            Compared against{' '}
            <span className="font-mono text-ink-muted" title={status.root}>
              {shortenPath(status.root, { max: 44 })}
            </span>
            .
          </>
        )}
      </p>

      <ul className="flex flex-col gap-1">
        {rows.map(({ dir, observed, summary }) => (
          <li key={dir} className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-2xs text-ink-faint" title={dir}>
                {shortenPath(dir, { max: 52 })}
              </span>
              {summary === null ? null : (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 text-2xs',
                    toneClasses.text[rowTone(summary, intended)],
                  )}
                >
                  <StatusDot tone={rowTone(summary, intended)} />
                  {rowLabel(summary)}
                </span>
              )}
            </div>
            {observed === null || summary === null ? null : (
              <RowDetail
                observed={observed}
                summary={summary}
                rootMissing={status?.rootMissing ?? []}
              />
            )}
          </li>
        ))}
      </ul>

      {status === null ? null : <Verdict status={status} intended={intended} />}
    </div>
  );
}

/**
 * How a row reads at a glance.
 *
 * The tone answers the pane's actual question — does this agree with the switch?
 * — rather than "is this shared", which is why a fully linked profile is amber
 * when the switch is off. That row is the "claims isolation that is not real"
 * case, and colouring it green because the links are tidy would be the display
 * agreeing with the disk and ignoring the user.
 */
function rowTone(summary: SharedConfigDirSummary, intended: boolean): Tone {
  switch (summary.state) {
    // Neither is a disagreement with anything: both scripts skip these by name.
    case 'root':
    case 'absent':
      return 'neutral';
    case 'shared':
      return intended ? 'mint' : 'amber';
    case 'partial':
      return 'amber';
    case 'unshared':
      return intended ? 'amber' : 'neutral';
  }
}

/** The state, in as few words as it can honestly be put. */
function rowLabel(summary: SharedConfigDirSummary): string {
  switch (summary.state) {
    // Not "nothing linked": this directory is what everything else is linked
    // *to*, and both scripts skip it. Reading it as unshared would leave the
    // user's own `~/.claude` looking permanently broken.
    case 'root':
      return 'is the root';
    case 'absent':
      return 'no such directory';
    case 'shared':
      return `all ${summary.linked} linked`;
    case 'partial':
      return `${summary.linked} linked, ${summary.gaps.length} not`;
    case 'unshared':
      return 'nothing linked';
  }
}

/**
 * The second line of a row: which entries are not linked, and what they are
 * instead.
 *
 * Grouped by state and named, because the count alone does not tell anyone what
 * to do. `own skills` is a folder with something in it and the share script will
 * move it aside; `missing plans` is nothing at all and costs nothing to link;
 * `foreign ide` is somebody else's arrangement that the undo script will refuse
 * to touch. Three different situations that a "2 not linked" would have flattened
 * into one number.
 *
 * The words are the four states the scripts already distinguish — see
 * `SharedConfigEntryState` — so this reads as the same vocabulary as the terminal
 * output the user just watched, rather than a second glossary for the same facts.
 */
function RowDetail({
  observed,
  summary,
  rootMissing,
}: {
  readonly observed: SharedConfigDirStatus;
  readonly summary: SharedConfigDirSummary;
  readonly rootMissing: readonly string[];
}): ReactElement | null {
  const groups = (['own', 'missing', 'foreign'] as const)
    .map((state) => ({
      state,
      names: observed.entries
        .filter((entry) => entry.state === state && entryGap(entry, rootMissing))
        .map((entry) => entry.name),
    }))
    .filter((group) => group.names.length > 0);

  if (groups.length === 0 && summary.backups.length === 0) return null;

  return (
    <p className="pl-3 text-2xs leading-relaxed text-ink-faint">
      {groups.map((group, index) => (
        <span key={group.state}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <span className="text-ink-muted">{group.state}</span>{' '}
          <span className="font-mono">{group.names.join(', ')}</span>
        </span>
      ))}
      {summary.backups.length > 0 ? (
        <span>
          {groups.length > 0 ? <span aria-hidden="true"> · </span> : null}
          {/* Mentioned because nothing in the app ever has. A share run renames
              whatever it displaces, and for `projects` that folder holds months
              of transcripts — sitting there, named, and until now invisible
              outside the terminal output that scrolled past. */}
          <span className="text-ink-muted">moved aside</span>{' '}
          <span className="font-mono">
            {summary.backups.map((name) => `${name}${BACKUP_SUFFIX}`).join(', ')}
          </span>
        </span>
      ) : null}
    </p>
  );
}

/**
 * One sentence on whether the disk agrees with the switch.
 *
 * Says so plainly in both directions, and says nothing dramatic when they agree
 * — the rows above already carry the detail, and a verdict that restated them
 * would just be a second paragraph to skim past. What it must never do is
 * *resolve* the disagreement by adjusting either side.
 */
function Verdict({
  status,
  intended,
}: {
  readonly status: SharedConfigStatus;
  readonly intended: boolean;
}): ReactElement | null {
  const disagrees = statusDisagrees(status, intended);
  // The one case the vocabulary itself explains: a file the root does not have
  // is one the share script deliberately skips, so `CLAUDE.md` reads as missing
  // everywhere and nothing is wrong. That `skip` line scrolled past in a
  // terminal is otherwise the only record of it.
  const skipped = SHARED_FILES.filter((name) => status.rootMissing.includes(name));

  if (!disagrees && skipped.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-t border-line pt-1.5">
      {disagrees ? (
        <p className="text-2xs leading-relaxed text-amber">
          {intended
            ? 'The switch is on, but the disk does not match it. Run the script below — it leaves what is already linked alone.'
            : 'Sharing is off here, but these profiles still point at your ~/.claude. Run the undo script below to separate them again.'}
        </p>
      ) : null}
      {skipped.length > 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Your <span className="font-mono text-ink-muted">~/.claude</span> has no{' '}
          <span className="font-mono text-ink-muted">{skipped.join(', ')}</span>, so the script does
          not link {skipped.length === 1 ? 'one' : 'them'}. That is a skip, not a gap.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The script                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How much of the machine the script on screen covers.
 *
 * `narrow` is offered only when the reading says it would be genuinely smaller —
 * see {@link dirsNeedingWork}. Both scripts are safe over everything, so this is
 * not a correctness knob; it is the difference between reading a script that
 * touches five directories and one that touches the two that are actually going
 * to change.
 */
type ScriptScope = 'all' | 'narrow';

function ScriptBlock({
  dirs,
  mode,
  status,
}: {
  readonly dirs: readonly string[];
  readonly mode: SharedConfigMode;
  /** The reading, or `null` while it is in flight or after it failed. */
  readonly status: SharedConfigStatus | null;
}): ReactElement {
  /*
   * Defaults to the narrow script, and falls back to all of them whenever there
   * is no narrower set to offer — which is the state before the reading lands, so
   * the pane's first paint is the same full script it has always shown and the
   * choice only appears once there is something to choose between.
   */
  const [scope, setScope] = useState<ScriptScope>('narrow');

  const narrow = useMemo(
    () => (status === null ? [] : dirsNeedingWork(status, mode)),
    [status, mode],
  );
  // Nothing to choose when the narrow set is empty (there is no work to do) or
  // when it is everything (the two scripts would be the same text).
  const canNarrow = narrow.length > 0 && narrow.length < dirs.length;
  const covered = canNarrow && scope === 'narrow' ? narrow : dirs;

  const script = useMemo(() => buildSharedConfigScript(covered, mode), [covered, mode]);

  // The tick waits for the write to resolve, and a refusal says so rather than
  // ticking anyway — see `useCopy`, which is where that rule now lives.
  const [copied, copy] = useCopy(script, {
    title: 'Could not copy the script',
    description: 'Select the text above and copy it by hand.',
  });

  const sharing = mode === 'share';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-2xs leading-relaxed text-ink-muted">
          {sharing ? (
            <>
              Quit Artemis, run this in a terminal, then start it again. It covers{' '}
              {countProfiles(covered.length)} and nothing else on your machine.
            </>
          ) : (
            <>
              This undoes it for {countProfiles(covered.length)}: the links go, and anything moved
              aside comes back. Safe to run even if you never ran the other one.
            </>
          )}
        </p>
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={copy}
          aria-label={sharing ? 'Copy the sharing script' : 'Copy the undo script'}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {canNarrow ? (
        /*
         * The pane's own exclusive-choice control rather than a pair of
         * `aria-pressed` buttons — see `pane.tsx` on why that distinction is not
         * cosmetic. Two options, one sentence each, and the sentences are the
         * point: "safe either way" is what makes choosing the short one
         * comfortable, and it is not guessable from the labels.
         */
        <ChoiceList<ScriptScope>
          label="How much the script covers"
          value={scope}
          onChange={setScope}
          choices={[
            {
              id: 'narrow',
              label: narrowLabel(narrow.length, sharing),
              note: 'Shorter to read, and it changes nothing that is already the way you want it.',
            },
            {
              id: 'all',
              label: `All ${countProfiles(dirs.length)}`,
              note: sharing
                ? 'Re-runnable over everything: a link that already points at the root is left alone and no second backup is made.'
                : 'Walks every profile. Anything that is not this arrangement’s own link is left alone.',
            },
          ]}
        />
      ) : null}

      {/* The directories the script on screen actually names. Kept even though
          the status block above lists them all: which of them this text covers
          is the one thing the code block cannot be skimmed for. */}
      <ul className="flex flex-col gap-0.5">
        {covered.map((dir) => (
          <li key={dir} className="font-mono text-2xs text-ink-faint" title={dir}>
            {shortenPath(dir, { max: 56 })}
          </li>
        ))}
      </ul>

      <CodeBlock text={script} />
    </div>
  );
}

/** "one profile" / "3 profiles". Reused so the two script blurbs cannot drift. */
function countProfiles(count: number): string {
  return count === 1 ? 'one profile' : `${count} profiles`;
}

/**
 * The narrow option's label, which has to survive being singular.
 *
 * Spelled out rather than composed from {@link countProfiles}, because "the one
 * profile that are not linked" is what composition produces and a settings pane
 * that cannot count to one reads as one that was not proofread.
 */
function narrowLabel(count: number, sharing: boolean): string {
  if (count === 1) {
    return sharing ? 'Only the profile that is not linked' : 'Only the profile still linked';
  }
  return sharing ? `Only the ${count} that are not linked` : `Only the ${count} still linked`;
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
