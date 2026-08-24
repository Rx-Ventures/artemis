/**
 * Memory banks — Cerebro generalized, as a settings pane.
 * ============================================================================
 *
 * The banks run themselves: a sync at every run start, agents drafting into
 * them, pull requests reviewing them. So the pane exists for the two moments
 * automation cannot cover. Onboarding — joining, creating, or adopting a bank
 * — and *inspection*, when a person wants to read what agents have been
 * remembering, prune what no longer holds, and decide which banks this
 * machine carries. Everything else here is deliberately a window, not a
 * control surface.
 *
 * ---------------------------------------------------------------------------
 * ADDING A MEMORY IS NOT A PANE ACTION
 * ---------------------------------------------------------------------------
 *
 * There used to be a draft form here, and it was removed on purpose (Seth,
 * 2026-08-17): memories enter a bank through agents, who are prompted to
 * write them in house style — scoped to their repos, description as a
 * retrieval hook, absolute dates — and to route team facts there rather than
 * to personal memory. A human-facing form was a second authoring path that
 * knew none of that. The human way to add a fact is to state it to an agent,
 * which is also the cheaper way. What remains human is *pruning*: `retire`
 * stays, because deciding a fact no longer holds is exactly the judgment the
 * inspection moment exists for. It runs through the bank's own gates and
 * answers with a receipt (the CLI's own words) rather than optimistically
 * mutating the list.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF SWITCH, AND WHY BOTH ARE BUTTONS
 * ---------------------------------------------------------------------------
 *
 * Each bank has a wiring switch (the CLI's, honoured by stock Claude Code's
 * hook too) and Artemis has one master gate (prompt + run-start syncs). Both
 * render as buttons, not `Switch`es: the per-bank one spawns `enable`/
 * `disable` and a sync, takes seconds and can fail, and a toggle that
 * animates to a position it then has to animate back from is lying twice.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { MemoryBankInfo, MemoryBankMemory, MemoryBankRole } from '@rx-artemis/protocol';

import { useMemoryBanks, type MemoryBanksPane } from '../../hooks/useMemoryBanks';
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

export function MemoryBanksSection(): ReactElement {
  const pane = useMemoryBanks();
  const hasBanks = (pane.status?.banks.length ?? 0) > 0;

  return (
    <SettingsPane
      title="Memory banks"
      description="Shared, agent-maintained git repositories of durable facts — reviewed like code, installed into every session's memory."
      actions={
        pane.status !== null && pane.status.masterEnabled && hasBanks ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pane.busy !== null || pane.reading}
            onClick={() => pane.sync()}
          >
            {pane.busy === 'sync' ? 'Syncing…' : 'Sync all'}
          </Button>
        ) : undefined
      }
    >
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.reading && pane.status === null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the banks…</p>
      ) : null}

      {pane.status !== null && hasBanks ? <MasterGroup pane={pane} /> : null}
      {pane.status !== null && hasBanks ? <BanksGroup pane={pane} /> : null}
      {pane.status !== null ? <AddGroup pane={pane} first={!hasBanks} /> : null}

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
/* The master gate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Artemis's own switch, narrower than each bank's: it decides whether runs
 * are briefed about the banks and whether Artemis syncs them at run start.
 * Off is the default — banks being configured is not consent to spending
 * every run's context on them.
 */
function MasterGroup({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
  const on = pane.status?.masterEnabled === true;
  const working = pane.busy === 'master';

  return (
    <SettingsGroup label={on ? 'On for Artemis' : 'Off for Artemis'}>
      <div className="flex items-start gap-3 rounded-md border border-line bg-panel px-3 py-2.5">
        <StatusDot tone={on ? 'mint' : 'amber'} />
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-muted">
          {on
            ? 'Every run syncs the enabled banks before it starts, and agents are told to consult them and record what they learn. The per-bank switches below decide which banks take part.'
            : 'Artemis is not using the banks: no run-start syncs, and agents are not briefed. The machine wiring (hooks and profile blocks for stock Claude Code) stays as the per-bank switches left it.'}
        </p>
        <Button
          size="sm"
          variant={on ? 'outline' : 'default'}
          disabled={pane.busy !== null || pane.reading}
          onClick={() => pane.setMasterEnabled(!on)}
        >
          {working ? (on ? 'Turning off…' : 'Turning on…') : on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* The banks                                                                  */
/* -------------------------------------------------------------------------- */

function BanksGroup({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
  const banks = pane.status?.banks ?? [];
  return (
    <SettingsGroup label={`Banks (${banks.length})`}>
      <div className="flex flex-col gap-2">
        {banks.map((bank) => (
          <BankCard key={bank.slug} bank={bank} pane={pane} />
        ))}
      </div>
    </SettingsGroup>
  );
}

function BankCard({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const working = pane.busy === 'switch';
  // Controlled, because `Fold` routes `onOpenChange` only in controlled mode —
  // and opening is when the bank's memories are actually worth a CLI spawn.
  const [memoriesOpen, setMemoriesOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={bank.enabled && bank.exists ? 'mint' : 'amber'} />
        <span className="font-mono text-xs font-medium text-ink">{bank.slug}</span>
        <ToneBadge tone="neutral">{bank.role === 'readonly' ? 'read-only' : 'read-write'}</ToneBadge>
        {bank.isDefault ? <ToneBadge tone="neutral">default</ToneBadge> : null}
        {!bank.exists ? <ToneBadge tone="signal">missing on disk</ToneBadge> : null}
        <span className="ml-auto flex items-center gap-1">
          {bank.enabled ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-2xs"
              disabled={pane.busy !== null}
              onClick={() => pane.sync(bank.slug)}
            >
              {pane.busy === 'sync' ? 'Syncing…' : 'Sync'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={bank.enabled ? 'ghost' : 'default'}
            className="text-2xs"
            disabled={pane.busy !== null}
            onClick={() => pane.setEnabled(bank.slug, !bank.enabled)}
          >
            {working ? '…' : bank.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          <ForgetButton bank={bank} pane={pane} />
        </span>
      </div>
      <Row label="Repo">{bank.path}</Row>
      <Row label="Remote">{bank.remote ?? 'none — changes commit locally'}</Row>
      <Row label="Bank">
        {`${bank.memories} memories · ${bank.validationErrors} validation errors · installed in ${bank.projects} projects`}
      </Row>
      <Fold
        summary={<span className="text-2xs">memories</span>}
        open={memoriesOpen}
        onOpenChange={(open) => {
          setMemoriesOpen(open);
          if (open) pane.loadMemories(bank.slug);
        }}
      >
        <BankMemories bank={bank} pane={pane} />
      </Fold>
    </div>
  );
}

function BankMemories({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const [query, setQuery] = useState('');
  const loaded = pane.memories[bank.slug];

  const visible = useMemo(() => {
    const all = loaded ?? [];
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return all;
    return all.filter(
      (memory) =>
        memory.name.toLowerCase().includes(needle) ||
        memory.description.toLowerCase().includes(needle) ||
        memory.body.toLowerCase().includes(needle),
    );
  }, [loaded, query]);

  if (loaded === undefined) {
    return <p className="text-2xs leading-relaxed text-ink-faint">Reading the bank…</p>;
  }

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name, description, or body…"
        spellCheck={false}
        className="max-w-sm text-xs md:text-xs"
        aria-label={`Filter ${bank.slug} memories`}
      />
      {visible.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          {loaded.length === 0 ? 'The bank is empty.' : 'No memory matches the filter.'}
        </p>
      ) : (
        visible.map((memory) => (
          <MemoryCard key={memory.name} bank={bank} memory={memory} pane={pane} />
        ))
      )}
    </div>
  );
}

function MemoryCard({
  bank,
  memory,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly memory: MemoryBankMemory;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  const provenance = [memory.added, memory.author].filter((part) => part !== null).join(' · ');

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-ink">{memory.name}</span>
        <ToneBadge tone="neutral">{memory.type}</ToneBadge>
        <span className="ml-auto">
          {/* Retirement is a write, and a read-only bank takes none. */}
          {bank.role === 'readwrite' ? <RetireButton bank={bank} memory={memory} pane={pane} /> : null}
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
  bank,
  memory,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly memory: MemoryBankMemory;
  readonly pane: MemoryBanksPane;
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
          <AlertDialogAction
            onClick={() =>
              pane.retire({ slug: bank.slug, name: memory.name, reason: 'retired from Artemis settings' })
            }
          >
            Retire
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Forgetting asks first: it unwires the bank and removes its installed copies. */
function ForgetButton({
  bank,
  pane,
}: {
  readonly bank: MemoryBankInfo;
  readonly pane: MemoryBanksPane;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-2xs text-ink-faint" disabled={pane.busy !== null}>
          {pane.busy === 'forget' ? 'Removing…' : 'Remove…'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{bank.slug}” from this machine?</AlertDialogTitle>
          <AlertDialogDescription>
            The bank is unwired from every profile, its installed memories come out of project
            memory, and it is forgotten from the machine&apos;s config. The repository at{' '}
            <span className="font-mono">{bank.path}</span> stays on disk untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={() => pane.forget(bank.slug)}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Adding a bank — the onboarding moment                                      */
/* -------------------------------------------------------------------------- */

type AddMode = 'join' | 'create' | 'adopt';

function AddGroup({
  pane,
  first,
}: {
  readonly pane: MemoryBanksPane;
  readonly first: boolean;
}): ReactElement {
  const [mode, setMode] = useState<AddMode>('join');
  const [slug, setSlug] = useState('');
  const [remote, setRemote] = useState('');
  const [path, setPath] = useState('');
  const [readonly, setReadonly] = useState(false);
  const blocked = pane.preflight !== null && !pane.preflight.ready;

  const slugOk = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
  const ready =
    slugOk &&
    (mode !== 'join' || remote.trim().length > 0) &&
    (mode !== 'adopt' || path.trim().length > 0);

  const submit = async (): Promise<void> => {
    const ok = await pane.add({
      mode,
      slug,
      role: readonly ? 'readonly' : 'readwrite',
      ...(remote.trim().length > 0 ? { remote: remote.trim() } : {}),
      ...(path.trim().length > 0 ? { path: path.trim() } : {}),
    });
    if (ok) {
      setSlug('');
      setRemote('');
      setPath('');
      setReadonly(false);
    }
  };

  return (
    <SettingsGroup label={first ? 'Set up' : 'Add a bank'}>
      {first ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          No memory bank is on this machine yet. Join your team&apos;s bank from its git remote,
          create a fresh local one (shareable later — the CLI travels inside it), or adopt a
          folder that already is a bank. From then on it maintains itself: agents record durable
          facts as they surface, and every change lands as a reviewed commit or pull request.
        </p>
      ) : null}

      {pane.preflight === null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Checking what this machine needs…</p>
      ) : (
        <RequirementList pane={pane} />
      )}

      <div className="flex flex-col gap-2 rounded-md border border-line bg-panel px-3 py-2.5">
        <div className="flex items-center gap-1">
          {(['join', 'create', 'adopt'] as const).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              variant={mode === candidate ? 'default' : 'ghost'}
              className="text-2xs"
              onClick={() => setMode(candidate)}
            >
              {candidate === 'join' ? 'Join a shared bank' : candidate === 'create' ? 'Create local' : 'Adopt a folder'}
            </Button>
          ))}
        </div>
        <p className="text-2xs leading-relaxed text-ink-faint">
          {mode === 'join'
            ? 'Clones the bank from its git remote. Memories you record land as auto-merging pull requests.'
            : mode === 'create'
              ? 'Starts an empty bank on this machine. No remote, no network — memories land as plain commits. Add a remote later to share it.'
              : 'Registers a directory that already holds a bank (a memories/ folder).'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="short-name (e.g. team, client-docs)"
            spellCheck={false}
            className="w-56 text-xs md:text-xs"
            aria-label="Bank slug"
          />
          {mode === 'join' ? (
            <Input
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              placeholder="git remote URL (https or ssh)"
              spellCheck={false}
              className="w-80 text-xs md:text-xs"
              aria-label="Bank remote URL"
            />
          ) : null}
          {mode !== 'join' ? (
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={mode === 'adopt' ? 'folder that holds the bank' : `~/Documents/<short-name>`}
              spellCheck={false}
              className="w-80 text-xs md:text-xs"
              aria-label="Bank path"
            />
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-2xs text-ink-muted">
          <input
            type="checkbox"
            checked={readonly}
            onChange={(event) => setReadonly(event.target.checked)}
          />
          Read-only on this machine — consult it, never draft, promote, or retire into it
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={pane.busy !== null || blocked || !ready} onClick={() => void submit()}>
            {pane.busy === 'add'
              ? mode === 'join'
                ? 'Joining…'
                : mode === 'create'
                  ? 'Creating…'
                  : 'Adopting…'
              : mode === 'join'
                ? 'Join bank'
                : mode === 'create'
                  ? 'Create bank'
                  : 'Adopt bank'}
          </Button>
          <Button size="sm" variant="ghost" disabled={pane.busy !== null} onClick={pane.refresh}>
            Re-check
          </Button>
          {blocked ? (
            <span className="text-2xs text-amber">
              Fix the requirements above first — it would fail partway through.
            </span>
          ) : null}
        </div>
      </div>
    </SettingsGroup>
  );
}

/**
 * The requirements, each with its fix.
 *
 * Shown before onboarding rather than after a failure: every one of these has
 * a one-line remedy, and a user who learns about a missing git identity from a
 * half-finished clone has been told the least useful version of the truth.
 * `warn` rows stay visible — "works, but you will open pull requests by hand"
 * is worth knowing before the first one appears.
 */
function RequirementList({ pane }: { readonly pane: MemoryBanksPane }): ReactElement {
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
