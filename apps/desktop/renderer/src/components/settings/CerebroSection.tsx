/**
 * Cerebro — the team memory bank, as a settings pane.
 * ============================================================================
 *
 * The bank runs itself: a SessionStart hook syncs it, agents draft into it,
 * pull requests review it. So the first question this pane had to answer was
 * why it exists at all — and the answer is the two moments automation cannot
 * cover. Onboarding, when the repo is not cloned yet and there is no hook to
 * run; and *inspection*, when a person wants to read what the team's agents
 * have been remembering and prune what no longer holds. Everything else here
 * is deliberately a window, not a control surface.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MEMORY IS NOT A PANE ACTION
 * ---------------------------------------------------------------------------
 *
 * There used to be a draft form here, and it was removed on purpose (Seth,
 * 2026-08-17): memories enter the bank through agents, who are prompted to
 * write them in house style — scoped to their repos, description as a
 * retrieval hook, absolute dates — and to route team facts here rather than
 * to personal memory. A human-facing form was a second authoring path that
 * knew none of that. The human way to add a fact is to state it to an agent,
 * which is also the cheaper way. What remains human is *pruning*: `retire`
 * stays, because deciding a fact no longer holds is exactly the judgment the
 * inspection moment exists for. It runs through the bank's own gates and
 * answers with a receipt (the CLI's own words) rather than optimistically
 * mutating the list — the honest outcome is "a commit landed" or "a pull
 * request is open", and the list only changes when a re-read says it did.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BODIES ARE FOLDED, NOT TRUNCATED
 * ---------------------------------------------------------------------------
 *
 * A memory's description is written as its retrieval hook ("when is this
 * relevant?"), so the collapsed row is already the useful register. The body
 * is the evidence, shown verbatim in a `CodeBlock` — ellipsizing a fact file
 * would invite the reader to trust a sentence the bank never wrote.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { CerebroMemory } from '@rx-artemis/protocol';

import { useCerebro, type CerebroPane } from '../../hooks/useCerebro';
import { CodeBlock, Fold, Row, StatusDot, ToneBadge } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function CerebroSection(): ReactElement {
  const pane = useCerebro();

  return (
    <SettingsPane
      title="Cerebro"
      description="The team's shared memory bank — agent-maintained, reviewed like code, installed into every session's memory."
      actions={
        // Only while it is on. A sync button on a bank the user has switched off
        // offers to do the one thing they just said to stop doing.
        pane.status?.installed === true && pane.status.enabled ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pane.busy !== null || pane.reading}
            onClick={pane.sync}
          >
            {pane.busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
        ) : undefined
      }
    >
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.reading && pane.status === null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the bank…</p>
      ) : null}

      {pane.status !== null && !pane.status.installed ? <SetupGroup pane={pane} /> : null}
      {pane.status !== null && pane.status.installed ? <SwitchGroup pane={pane} /> : null}
      {pane.status !== null && pane.status.installed ? <ConnectionGroup pane={pane} /> : null}
      {pane.status !== null && pane.status.installed ? <MemoriesGroup pane={pane} /> : null}

      {pane.lastAction !== null ? (
        <CodeBlock
          text={pane.lastAction.message}
          tone={pane.lastAction.ok ? 'neutral' : 'error'}
          className="max-h-32"
        />
      ) : null}
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Not set up yet — the onboarding moment                                     */
/* -------------------------------------------------------------------------- */

function SetupGroup({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const blocked = pane.preflight !== null && !pane.preflight.ready;

  return (
    <SettingsGroup label="Set up">
      <p className="text-2xs leading-relaxed text-ink-muted">
        Cerebro is not on this machine yet. Setting it up clones the team bank, wires every
        profile (instruction block, <span className="font-mono">/cerebro</span> command, and a
        session-start sync hook), and installs the memories into your projects. From then on it
        maintains itself — agents record team facts as they surface, and every change lands as a
        reviewed commit or pull request.
      </p>

      {pane.preflight === null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Checking what this machine needs…</p>
      ) : (
        <RequirementList pane={pane} />
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pane.busy !== null || blocked} onClick={pane.setup}>
          {pane.busy === 'setup' ? 'Setting up…' : 'Set up Cerebro'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pane.busy !== null} onClick={pane.refresh}>
          Re-check
        </Button>
        {blocked ? (
          <span className="text-2xs text-amber">
            Fix the requirements above first — setup would fail partway through.
          </span>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

/**
 * The requirements, each with its fix.
 *
 * Shown before setup rather than after a failure: every one of these has a
 * one-line remedy, and a user who learns about a missing git identity from a
 * half-finished clone has been told the least useful version of the truth.
 * `warn` rows stay visible — "works, but you will open pull requests by hand"
 * is worth knowing before the first one appears.
 */
function RequirementList({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const checks = pane.preflight?.checks ?? [];

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">
      {checks.map((entry) => (
        <div key={entry.id} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2 text-2xs">
            <StatusDot
              tone={entry.state === 'ok' ? 'mint' : entry.state === 'warn' ? 'amber' : 'signal'}
            />
            <span className="font-medium text-ink">{entry.label}</span>
            <span className="min-w-0 flex-1 truncate text-ink-faint" title={entry.detail}>
              {entry.detail}
            </span>
          </div>
          {entry.state !== 'ok' && entry.remedy !== null ? (
            <p className="pl-4 font-mono text-2xs leading-relaxed text-ink-muted">{entry.remedy}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The master switch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * On or off, for the whole feature, on the pane named after it.
 *
 * Off is the default and the reason is consent rather than caution: the bank
 * writes to a repository the team shares, and its prompt spends context on
 * every run. Finding the CLI cloned on disk is evidence that somebody once
 * tried it, which is not the same as this machine agreeing to sync and to brief
 * every agent about it today.
 *
 * A `Button` and not a `Switch`, which is the one design choice here worth
 * defending. A switch promises an instant, local flip; this spawns `cerebro
 * enable` or `disable`, re-wires every profile, forces a sync on the way in,
 * takes seconds and can fail. Rendering that as a toggle would mean animating
 * to the new position and then silently animating back — so it reads as what it
 * is, an action with a receipt, sharing `busy` and `lastAction` with the
 * buttons beside it.
 */
function SwitchGroup({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const on = pane.status?.enabled === true;
  const working = pane.busy === 'switch';

  return (
    <SettingsGroup label={on ? 'On' : 'Off'}>
      <div className="flex items-start gap-3 rounded-md border border-line bg-panel px-3 py-2.5">
        <StatusDot tone={on ? 'mint' : 'amber'} />
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-muted">
          {on
            ? 'Every run syncs the bank before it starts, and agents are told to consult it and to record what they learn. Turning this off unwires every profile — the instruction block, the /cerebro command and the session-start hook all come out — and stops the prompt being sent.'
            : 'The bank is cloned but nothing is using it: no sync runs, no agent is told about it, and no profile is wired up. Turning it on re-runs the same wiring set-up does, then syncs once.'}
        </p>
        <Button
          size="sm"
          variant={on ? 'outline' : 'default'}
          disabled={pane.busy !== null || pane.reading}
          onClick={() => pane.setEnabled(!on)}
        >
          {working ? (on ? 'Turning off…' : 'Turning on…') : on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function ConnectionGroup({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const status = pane.status;
  if (status === null) return <></>;

  return (
    <SettingsGroup label="Connection">
      <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">
        <Row label="Repo">{status.repoPath}</Row>
        <Row label="Remote">{status.remote ?? 'none — changes commit locally'}</Row>
        <Row label="Source">{status.source ?? 'unknown'}</Row>
        <Row label="Bank">
          {`${status.memories} memories · ${status.validationErrors} validation errors · installed in ${status.projects} projects`}
        </Row>
      </div>
      <div className="flex flex-col gap-1">
        {status.profiles.map((profile) => (
          <div key={profile.name} className="flex items-center gap-2 text-2xs text-ink-muted">
            <StatusDot tone={profile.enabled && profile.hook ? 'mint' : 'amber'} />
            <span className="font-medium text-ink">{profile.name}</span>
            <span className="text-ink-faint">{profile.label}</span>
            <span className="ml-auto text-ink-faint">
              {profile.enabled && profile.hook
                ? 'enabled + sync hook'
                : profile.enabled
                  ? 'enabled, hook missing — run set up again'
                  : 'not enabled'}
            </span>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* The memories                                                               */
/* -------------------------------------------------------------------------- */

function MemoriesGroup({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return pane.memories;
    return pane.memories.filter(
      (memory) =>
        memory.name.toLowerCase().includes(needle) ||
        memory.description.toLowerCase().includes(needle) ||
        memory.body.toLowerCase().includes(needle),
    );
  }, [pane.memories, query]);

  return (
    <SettingsGroup label={`Memories (${pane.memories.length})`}>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name, description, or body…"
        spellCheck={false}
        className="max-w-sm text-xs md:text-xs"
        aria-label="Filter memories"
      />
      {visible.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {pane.memories.length === 0 ? 'The bank is empty.' : 'No memory matches the filter.'}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visible.map((memory) => (
            <MemoryCard key={memory.name} memory={memory} pane={pane} />
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

function MemoryCard({
  memory,
  pane,
}: {
  readonly memory: CerebroMemory;
  readonly pane: CerebroPane;
}): ReactElement {
  const provenance = [memory.added, memory.author].filter((part) => part !== null).join(' · ');

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-ink">{memory.name}</span>
        <ToneBadge tone="neutral" className="uppercase">
          {memory.type}
        </ToneBadge>
        <span className="ml-auto">
          <RetireButton memory={memory} pane={pane} />
        </span>
      </div>
      <p className="text-2xs leading-relaxed text-ink-muted">{memory.description}</p>
      <Fold summary={<span className="text-2xs">file body</span>}>
        <CodeBlock text={memory.body} className="max-h-56" />
      </Fold>
      {provenance.length > 0 ? (
        <p className="font-mono text-2xs text-ink-faint">{provenance}</p>
      ) : null}
    </div>
  );
}

/**
 * Retirement asks first. Not because it is destructive on this machine — it
 * lands through the bank's gates like any other change, and `git revert` undoes
 * it — but because with a remote it opens a pull request the whole team sees.
 */
function RetireButton({
  memory,
  pane,
}: {
  readonly memory: CerebroMemory;
  readonly pane: CerebroPane;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-2xs text-ink-faint" disabled={pane.busy !== null}>
          {pane.busy === 'retire' ? 'Retiring…' : 'Retire…'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retire “{memory.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The memory is removed through the bank&apos;s own gates — a commit, or a pull request
            for the team to review once a remote is configured. Git history keeps it recoverable.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => pane.retire({ name: memory.name, reason: 'retired from Artemis settings' })}>
            Retire
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

