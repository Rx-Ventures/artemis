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
 * EVERY WRITE GOES THROUGH THE BANK'S OWN GATES
 * ---------------------------------------------------------------------------
 *
 * "Add" here is `draft` + `promote`, and "remove" is `retire` — the same CLI
 * verbs the agents use, with the same validator and the same PR path once a
 * remote exists. This pane never edits a file in the bank directly, which is
 * why its write buttons answer with a receipt (the CLI's own words) rather
 * than optimistically mutating the list: the honest outcome of a write is "a
 * commit landed" or "a pull request is open", and the list only changes when
 * a re-read says it did.
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
import type { CerebroMemory, CerebroMemoryType } from '@rx-artemis/protocol';
import { CEREBRO_MEMORY_TYPES } from '@rx-artemis/protocol';

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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** One line per type, for the draft form. The bank's docs say the rest. */
const TYPE_NOTES: Record<CerebroMemoryType, string> = {
  reference: 'A pointer or fact: what something is, where it lives.',
  feedback: 'Guidance on how to work, with the why attached.',
  project: 'Ongoing work or constraints the code does not record.',
  user: 'Who someone is — role, expertise, preferences.',
};

export function CerebroSection(): ReactElement {
  const pane = useCerebro();

  return (
    <SettingsPane
      title="Cerebro"
      description="The team's shared memory bank — agent-maintained, reviewed like code, installed into every session's memory."
      actions={
        pane.status?.installed === true ? (
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
      {pane.status !== null && pane.status.installed ? <ConnectionGroup pane={pane} /> : null}
      {pane.status !== null && pane.status.installed ? <MemoriesGroup pane={pane} /> : null}
      {pane.status !== null && pane.status.installed ? <DraftGroup pane={pane} /> : null}

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

/* -------------------------------------------------------------------------- */
/* New memory                                                                 */
/* -------------------------------------------------------------------------- */

function DraftGroup({ pane }: { readonly pane: CerebroPane }): ReactElement {
  const [name, setName] = useState('');
  const [type, setType] = useState<CerebroMemoryType>('reference');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');

  const ready = name.length > 0 && description.length > 0 && body.length > 0;

  const submit = async (): Promise<void> => {
    const landed = await pane.draft({ name, type, description, body });
    if (landed) {
      setName('');
      setDescription('');
      setBody('');
    }
  };

  return (
    <SettingsGroup label="New memory">
      <p className="text-2xs leading-relaxed text-ink-faint">
        Agents record most memories on their own; this form is for the fact you want to state
        yourself. It goes through the same validation and review gates either way. Re-using an
        existing name updates that memory.
      </p>
      <div className="flex gap-2">
        <Field className="flex-1">
          <FieldLabel htmlFor="cerebro-draft-name" className="text-2xs text-ink-faint uppercase">
            Name
          </FieldLabel>
          <Input
            id="cerebro-draft-name"
            value={name}
            onChange={(event) => setName(event.target.value.toLowerCase())}
            placeholder="deploy-approval-flow"
            spellCheck={false}
            className="font-mono text-xs md:text-xs"
          />
          <FieldDescription className="text-2xs">Kebab-case slug; becomes the filename.</FieldDescription>
        </Field>
        <Field className="flex-1">
          <FieldLabel className="text-2xs text-ink-faint uppercase">Type</FieldLabel>
          <div className="flex flex-wrap gap-1">
            {CEREBRO_MEMORY_TYPES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === type ? 'secondary' : 'ghost'}
                aria-pressed={option === type}
                className="text-2xs"
                onClick={() => setType(option)}
              >
                {option}
              </Button>
            ))}
          </div>
          <FieldDescription className="text-2xs">{TYPE_NOTES[type]}</FieldDescription>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor="cerebro-draft-description" className="text-2xs text-ink-faint uppercase">
          Description
        </FieldLabel>
        <Input
          id="cerebro-draft-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="When is this relevant?"
          className="text-xs md:text-xs"
        />
        <FieldDescription className="text-2xs">
          One line — it is the retrieval hook agents decide by.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="cerebro-draft-body" className="text-2xs text-ink-faint uppercase">
          Body
        </FieldLabel>
        <Textarea
          id="cerebro-draft-body"
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="The fact, stated plainly. Absolute dates. No secrets — the validator refuses them."
          className="text-xs md:text-xs"
        />
      </Field>
      <div>
        <Button size="sm" disabled={!ready || pane.busy !== null} onClick={() => void submit()}>
          {pane.busy === 'draft' ? 'Landing…' : 'Draft & land'}
        </Button>
      </div>
    </SettingsGroup>
  );
}
