/**
 * Agents — the standing instructions every run carries.
 * ============================================================================
 *
 * A prompt library and the rules for which accounts each prompt reaches. What
 * the user writes here is appended to the provider's own system prompt on every
 * run, which makes this the one settings pane whose contents the model actually
 * reads — and that fact governs almost every decision below.
 *
 * ---------------------------------------------------------------------------
 * A LIST AND AN EDITOR, NOT A PAGE OF EDITORS
 * ---------------------------------------------------------------------------
 *
 * The obvious layout is every prompt expanded down the page. It falls apart at
 * three: prompts are paragraphs, not settings, so a stacked page becomes a
 * document with no way to see what is in it. So the list is a table of
 * contents — name, on/off, who it reaches — and exactly one prompt is open.
 *
 * Selection is local state and is deliberately not persisted. Which prompt you
 * were last editing is not a preference, and restoring it would reopen a
 * document the user closed the app on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE LIST SHOWS PROFILES IT WILL NOT LET YOU TICK
 * ---------------------------------------------------------------------------
 *
 * Appending to a system prompt is a capability, not a universal: the Claude
 * adapter has one and the Codex adapter does not (see
 * `Capabilities.systemPromptAppend`). A Codex profile therefore cannot receive
 * a prompt from this pane, and the honest way to say so is to keep its row
 * exactly where it is, disabled, with the reason attached — the rule
 * `disabled-reason.tsx` exists to enforce. Hiding the row would leave a user
 * with two accounts wondering where the second one went, and would make "my
 * prompt is not working" a question with no visible answer.
 *
 * ---------------------------------------------------------------------------
 * BUILT-INS ARE DELETED BY BEING TURNED OFF
 * ---------------------------------------------------------------------------
 *
 * Artemis's own prompts have no delete button. Not to keep them: the read path
 * re-appends any built-in the document is missing (`parseAgentPromptsDocument`),
 * so a deleted one would reappear on the next open and read as the app
 * overruling the user. Turning it off is durable, does the same thing, and is
 * the only one of the two this app can honour.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { LockIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import type {
  AgentPrompt,
  AgentPromptScope,
  BuiltInPromptId,
  ProfileMetadata,
} from '@rx-artemis/protocol';
import { BUILT_IN_AGENT_PROMPTS, promptText, scopeCovers } from '@rx-artemis/protocol';

import { useAgentPrompts, type AgentPromptsPane } from '../../hooks/useAgentPrompts';
import { useMemoryBanksAvailable } from '../../hooks/useMemoryBanks';
import { newId } from '../../lib/id';
import { useApp } from '../../state/store';
import { WithReason } from '../disabled-reason';
import { MarkdownEditor } from '../MarkdownEditor';
import { StatusDot, ToneBadge } from '../primitives';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** What a profile can be told, and why not when it cannot. */
interface ScopeTarget {
  readonly profile: ProfileMetadata;
  readonly reachable: boolean;
  /** Empty when reachable; a full sentence when not. */
  readonly reason: string;
}

export function AgentsSection(): ReactElement {
  const pane = useAgentPrompts();
  const profiles = useApp((s) => s.profiles);
  const providers = useApp((s) => s.providers);

  // The banks' condition, for the one built-in that depends on them. Read from
  // the same module the memory-banks pane reads, so the two panes cannot
  // disagree about whether they are configured *and* switched on — which is
  // the conjunction `engine.ts` composes runs with, and the only thing that
  // makes this row's "not being sent" line true.
  const banksAvailable = useMemoryBanksAvailable();
  const availableBuiltIns = useMemo((): ReadonlySet<BuiltInPromptId> => {
    const available = new Set<BuiltInPromptId>();
    if (banksAvailable === true) available.add('builtin:cerebro');
    return available;
  }, [banksAvailable]);

  const targets = useMemo((): readonly ScopeTarget[] => {
    return profiles.map((profile) => {
      const descriptor = providers.find((entry) => entry.id === profile.providerId);
      // Unknown provider reads as reachable rather than as blocked. The
      // descriptor list is fetched, so a profile can legitimately render before
      // its provider arrives — and disabling a checkbox for one frame teaches
      // the user something false about their account.
      const reachable = descriptor === undefined || descriptor.capabilities.systemPromptAppend;
      return {
        profile,
        reachable,
        reason: reachable
          ? ''
          : `${descriptor?.label ?? profile.providerId} cannot take instructions appended to its system prompt, so prompts from this pane never reach this profile.`,
      };
    });
  }, [profiles, providers]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    pane.prompts.find((prompt) => prompt.id === selectedId) ?? pane.prompts[0] ?? null;

  const addPrompt = (): void => {
    const prompt: AgentPrompt = {
      id: newId('prompt'),
      name: 'New prompt',
      markdown: '',
      enabled: true,
      // `all` rather than the profiles that happen to exist, per
      // `AgentPromptScope`: a new prompt should keep applying to an account
      // added next month unless the user says otherwise.
      scope: { kind: 'all' },
    };
    pane.setPrompts([...pane.prompts, prompt]);
    setSelectedId(prompt.id);
  };

  return (
    <SettingsPane
      title="Agents"
      description="Standing instructions appended to the agent's system prompt on every run. Written once, sent every session."
      actions={<SaveIndicator pane={pane} />}
    >
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.loading ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the library…</p>
      ) : null}

      {!pane.loading && pane.error === null ? (
        <>
          <SettingsGroup label="Prompts">
            <div className="flex flex-col gap-1">
              {pane.prompts.map((prompt) => (
                <PromptRow
                  key={prompt.id}
                  prompt={prompt}
                  pane={pane}
                  targets={targets}
                  available={availableBuiltIns}
                  selected={prompt.id === selected?.id}
                  onSelect={() => setSelectedId(prompt.id)}
                />
              ))}
            </div>
            <div>
              <Button size="sm" variant="outline" onClick={addPrompt}>
                <PlusIcon aria-hidden="true" />
                New prompt
              </Button>
            </div>
          </SettingsGroup>

          {selected === null ? (
            <p className="text-2xs leading-relaxed text-ink-faint">
              No prompts yet. A new one is sent to every profile until you narrow it.
            </p>
          ) : (
            <PromptEditor
              key={selected.id}
              prompt={selected}
              pane={pane}
              targets={targets}
              available={availableBuiltIns}
            />
          )}
        </>
      ) : null}
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Save state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether what is on screen is on disk.
 *
 * Present because this pane has no save button — edits land on a debounce — and
 * a surface that writes silently owes the user a way to tell that it did. The
 * idle state says "Saved" rather than nothing, for the same reason: a blank
 * space is indistinguishable from a component that is broken.
 */
function SaveIndicator({ pane }: { readonly pane: AgentPromptsPane }): ReactElement | null {
  if (pane.loading || pane.error !== null) return null;
  if (pane.saveState.kind === 'error') {
    return <span className="text-2xs text-signal">{pane.saveState.message}</span>;
  }
  return (
    <span className="flex items-center gap-1.5 text-2xs text-ink-faint">
      <StatusDot tone={pane.saveState.kind === 'saving' ? 'amber' : 'mint'} />
      {pane.saveState.kind === 'saving' ? 'Saving…' : 'Saved'}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* One row in the list                                                        */
/* -------------------------------------------------------------------------- */

/** What a prompt's scope reads as in one line. */
function describeScope(
  scope: AgentPromptScope,
  targets: readonly ScopeTarget[],
): string {
  if (scope.kind === 'all') return 'every profile';
  const named = targets.filter((target) => scope.profileIds.includes(target.profile.id));
  if (named.length === 0) return 'no profiles — it will not be sent';
  if (named.length === 1) return named[0]!.profile.label;
  return `${named.length} profiles`;
}

function PromptRow({
  prompt,
  pane,
  targets,
  available,
  selected,
  onSelect,
}: {
  readonly prompt: AgentPrompt;
  readonly pane: AgentPromptsPane;
  readonly targets: readonly ScopeTarget[];
  readonly available: ReadonlySet<BuiltInPromptId>;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const builtIn = prompt.builtIn === undefined ? undefined : BUILT_IN_AGENT_PROMPTS[prompt.builtIn];
  const unavailable = prompt.builtIn !== undefined && !available.has(prompt.builtIn);

  const setEnabled = (enabled: boolean): void => {
    pane.setPrompts(pane.prompts.map((p) => (p.id === prompt.id ? { ...p, enabled } : p)));
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
        selected
          ? 'border-beam/45 bg-beam/5'
          : 'border-line bg-panel hover:border-line-strong hover:bg-raised',
      )}
    >
      {/*
        The row is a button and the switch is not inside it — a control inside a
        control is the pattern that produces a "select" that sometimes toggles,
        depending on where in the row the pointer landed.
      */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left outline-none focus-visible:underline"
      >
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-xs leading-snug font-medium',
              prompt.enabled ? 'text-ink' : 'text-ink-faint',
            )}
          >
            {prompt.name}
          </span>
          {builtIn ? (
            <ToneBadge tone="neutral" className="gap-1">
              <LockIcon aria-hidden="true" className="size-2.5" />
              built-in
            </ToneBadge>
          ) : null}
        </span>
        <span className="text-2xs leading-snug text-ink-faint">
          {prompt.enabled
            ? unavailable
              ? `On, but not sent — ${builtIn?.requires ?? 'its precondition'} is not true on this machine.`
              : `Sent to ${describeScope(prompt.scope, targets)}.`
            : 'Off — kept, never sent.'}
        </span>
      </button>

      <Switch
        checked={prompt.enabled}
        onCheckedChange={setEnabled}
        aria-label={`Send “${prompt.name}”`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The open prompt                                                            */
/* -------------------------------------------------------------------------- */

function PromptEditor({
  prompt,
  pane,
  targets,
  available,
}: {
  readonly prompt: AgentPrompt;
  readonly pane: AgentPromptsPane;
  readonly targets: readonly ScopeTarget[];
  readonly available: ReadonlySet<BuiltInPromptId>;
}): ReactElement {
  const builtIn = prompt.builtIn === undefined ? undefined : BUILT_IN_AGENT_PROMPTS[prompt.builtIn];
  const unavailable = prompt.builtIn !== undefined && !available.has(prompt.builtIn);

  const patch = (change: Partial<AgentPrompt>): void => {
    pane.setPrompts(pane.prompts.map((p) => (p.id === prompt.id ? { ...p, ...change } : p)));
  };

  const remove = (): void => {
    pane.setPrompts(pane.prompts.filter((p) => p.id !== prompt.id));
  };

  return (
    <SettingsGroup label={builtIn ? `${prompt.name} — Artemis's own` : 'Prompt'}>
      {builtIn ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          {builtIn.summary} Artemis wrote this one and keeps it current, so it is shown rather than
          edited. It is only sent when {builtIn.requires}.
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="chrome-label text-ink-faint">
              Name
            </span>
            <Input
              value={prompt.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="House style"
              className="text-xs md:text-xs"
            />
          </label>
          <DeleteButton name={prompt.name} onConfirm={remove} />
        </div>
      )}

      {unavailable ? (
        <p className="flex items-center gap-1.5 text-2xs leading-relaxed text-ink-faint">
          <StatusDot tone="amber" />
          Not being sent right now — {builtIn?.requires} is not true on this machine.
        </p>
      ) : null}

      <MarkdownEditor
        // Keyed by the caller, so this component never has to reconcile a
        // document change against a live ProseMirror instance. See
        // `MarkdownEditor` — `value` is read exactly once.
        value={builtIn ? promptText(prompt) : prompt.markdown}
        onChange={(markdown) => patch({ markdown })}
        readOnly={builtIn !== undefined}
        // Deliberately not the prompt's name. `MarkdownEditor` hands its
        // attributes to ProseMirror once, at construction, so a label built
        // from a field the user can rename would keep announcing the old name
        // for as long as the editor stays mounted — and the editor is
        // deliberately *not* remounted on a rename, so that renaming does not
        // discard the undo history. A stale accessible name is worse than a
        // general one; the group heading above carries the prompt's identity.
        ariaLabel="Prompt instructions"
        placeholder="Always run the typechecker before saying a change is done…"
      />

      <ScopePicker prompt={prompt} targets={targets} onChange={(scope) => patch({ scope })} />
    </SettingsGroup>
  );
}

function DeleteButton({
  name,
  onConfirm,
}: {
  readonly name: string;
  readonly onConfirm: () => void;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" className="text-ink-faint" aria-label={`Delete “${name}”`}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The text goes with it, and nothing here keeps a copy. To stop sending a prompt without
            losing what it says, turn it off instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which profiles this prompt reaches.
 *
 * "Every profile" is a checkbox above the list rather than a mode switch beside
 * it, because it is the *default* and the list underneath is what narrowing
 * looks like. Unticking it converts the standing answer into the concrete one —
 * seeded with every profile that can actually receive it, so the act of
 * narrowing does not itself turn every prompt off and make the user re-tick
 * what they already had.
 */
function ScopePicker({
  prompt,
  targets,
  onChange,
}: {
  readonly prompt: AgentPrompt;
  readonly targets: readonly ScopeTarget[];
  readonly onChange: (scope: AgentPromptScope) => void;
}): ReactElement {
  const all = prompt.scope.kind === 'all';

  const toggleProfile = (id: string, on: boolean): void => {
    const current = prompt.scope.kind === 'profiles' ? prompt.scope.profileIds : [];
    onChange({
      kind: 'profiles',
      profileIds: on ? [...current, id] : current.filter((entry) => entry !== id),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      <span className="chrome-label text-ink-faint">
        Applies to
      </span>

      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={all}
          onCheckedChange={(next) =>
            onChange(
              next === true
                ? { kind: 'all' }
                : {
                    kind: 'profiles',
                    profileIds: targets
                      .filter((target) => target.reachable)
                      .map((target) => target.profile.id),
                  },
            )
          }
        />
        <span className="flex flex-col">
          <span className="text-xs leading-snug text-ink">Every profile</span>
          <span className="text-2xs leading-snug text-ink-faint">
            Including accounts added later.
          </span>
        </span>
      </label>

      {all ? null : (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          {targets.length === 0 ? (
            <span className="text-2xs text-ink-faint">
              No profiles yet — add one in Profiles and it will appear here.
            </span>
          ) : null}
          {targets.map((target) => {
            const checked = scopeCovers(prompt.scope, target.profile.id);
            const row = (
              <label
                className={cn(
                  'flex items-center gap-2',
                  target.reachable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
                )}
              >
                <Checkbox
                  checked={checked && target.reachable}
                  disabled={!target.reachable}
                  onCheckedChange={(next) => toggleProfile(target.profile.id, next === true)}
                />
                <span className="text-xs leading-snug text-ink">{target.profile.label}</span>
                <span className="text-2xs text-ink-faint">{target.profile.providerId}</span>
              </label>
            );
            return target.reachable ? (
              <span key={target.profile.id}>{row}</span>
            ) : (
              <WithReason
                key={target.profile.id}
                reason={target.reason}
                focusable={false}
                side="right"
                className="w-fit"
              >
                {row}
              </WithReason>
            );
          })}
        </div>
      )}
    </div>
  );
}
