/**
 * What this conversation has delegated, and how it is going.
 * ============================================================================
 *
 *     ╭────────────────────────────────────────────╮
 *     │ ⏵ Explore  auth call sites   1m12s  ⏹      │
 *     │   Grep · 24.1k tok · 7 tools               │
 *     ╰────────────────────────────────────────────╯
 *     ╭────────────────────────────────────────────╮
 *     │ ⏵ review-changes (workflow)  3m40s  ⏹      │
 *     │   running · 310k tok                       │
 *     │ ⌄ Review 3/3 · Verify 1/4                  │
 *     ╰────────────────────────────────────────────╯
 *     › 4 finished
 *
 * ## Live on top, finished folded under it
 *
 * The pane answers one question — *is it still going* — and a flat list answers
 * it worst exactly when it matters most: a workflow that has settled thirty
 * agents pushes the two still running off the bottom. So the split is by
 * liveness rather than by arrival, and the settled half is behind one click
 * that is shut by default.
 *
 * Order is preserved *inside* each half. Rows arrive in the order they were
 * delegated, and one that reordered itself as it settled would be one the eye
 * has to find again — the same argument `visibleTabs` makes about the dock.
 *
 * ## Each item is a card
 *
 * The pane holds things of wildly different heights: a one-line `Bash` beside a
 * workflow with four phases and twenty agents folded under it. Run flat, the
 * phase tree of one reads as though it belonged to the next. A border is the
 * cheapest thing that says where one piece of work stops. A settled card is
 * recessed rather than raised, which does some of the same work as the heading
 * it sits under.
 *
 * The surface the transcript could not be. A turn that spawns three agents draws
 * as one folded line reading "delegated to 3 agents" — past tense, while they
 * work — because the `Agent` tool backgrounds by default and `Workflow` is always
 * async, so both close their tool call the instant the work starts. Everything
 * after that happens outside any turn, and a thread is the wrong shape for it: the
 * set is replaced as work comes and goes, so a row in a transcript would either be
 * rewritten in place in a surface that never rewrites, or become one entry per
 * change, which is a log of a list.
 *
 * ## The clock ticks here, not in the store
 *
 * A row's elapsed time is computed from `startedAt` against a clock this
 * component owns, ticking once a second while anything is live. The alternative
 * — carrying an elapsed number in the event — would mean a store write per task
 * per second, fanned out to every subscriber of a pane, to move some text by one
 * digit. The provider's own `durationMs` is preferred once it arrives, because it
 * measures the work rather than the time since Artemis heard about it.
 *
 * ## Stopping is a request
 *
 * The ⏹ on a row asks; the row settles when the provider says it has, through the
 * same path a natural finish takes. So the button does not optimistically strike
 * the row through — a stop that failed and a stop that worked would look
 * identical, and the first is the one worth noticing.
 */

import { memo, useEffect, useState, type ReactElement } from 'react';
import type { BackgroundTask, WorkflowAgent } from '@rx-artemis/protocol';
import { isTaskLive } from '@rx-artemis/protocol';
import { CheckIcon, ClockIcon, CircleStopIcon, PauseIcon, PlayIcon, XIcon } from 'lucide-react';

import {
  allLivePanes,
  canOpenSubagents,
  openAgentTab,
  stopTask,
  taskHasTranscript,
  useApp,
} from '../state/store';
import { paneState, type Pane, type PaneId } from '../state/pane';
import { IconButton } from './disabled-reason';
import { Fold, StatusDot } from './primitives';
import { cn } from '@/lib/utils';

/** How often the elapsed clocks move. One second: they are shown to that. */
const TICK_MS = 1_000;

export function TasksPane({ paneId }: { readonly paneId: PaneId }): ReactElement | null {
  // Looked up rather than passed, because the dock is a window-level surface: a
  // tab names the column it belongs to and the strip is drawn outside every
  // `PaneProvider`, so there is no context to read this from.
  const pane = useApp((s) => allLivePanes(s).find((one) => one.id === paneId));
  const tasks = usePaneTasks(pane);
  const now = useTicker(tasks.some(isTaskLive));

  if (pane === undefined) return null;

  if (tasks.length === 0) {
    return (
      <div className="grid flex-1 place-items-center p-4 text-2xs text-ink-faint">
        Nothing delegated yet.
      </div>
    );
  }

  /*
   * Live work on top, finished work folded underneath.
   *
   * The pane is opened to answer "is it still going", and a flat list answers
   * that worst exactly when it matters most: a workflow that has finished
   * thirty agents pushes the two that are still running off the bottom. So the
   * split is by liveness rather than by arrival, and only the live half is
   * unconditionally on screen.
   *
   * Order is preserved inside each half. The tasks arrive in the order they
   * were delegated and a row that moved as it settled would be a row the eye
   * has to re-find — the same reason `visibleTabs` refuses to reorder the dock.
   */
  const live = tasks.filter(isTaskLive);
  const finished = tasks.filter((task) => !isTaskLive(task));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
      {live.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Delegated work">
          {live.map((task) => (
            <TaskRow key={task.id} task={task} now={now} pane={pane} />
          ))}
        </ul>
      ) : null}

      {finished.length > 0 ? (
        <Fold
          /*
           * Shut by default, and *not* remembered per task.
           *
           * `rememberAs` is keyed on the pane rather than on anything that
           * changes, because the section itself is stable while its contents
           * are not: a task settling moves it into here, and a key that
           * included the set of finished tasks would spring the section open
           * again every time one arrived — which is precisely the moment the
           * user is least likely to want the pane to jump.
           */
          defaultOpen={false}
          rememberAs={`tasks-finished:${paneId}`}
          className={cn(live.length > 0 && 'mt-2')}
          triggerClassName="px-1 text-3xs"
          summary={
            <span className="text-3xs text-ink-faint">
              {finished.length} finished
            </span>
          }
        >
          <ul className="flex flex-col gap-1.5" aria-label="Finished work">
            {finished.map((task) => (
              <TaskRow key={task.id} task={task} now={now} pane={pane} />
            ))}
          </ul>
        </Fold>
      ) : null}
    </div>
  );
}

const TaskRow = memo(function TaskRow({
  task,
  now,
  pane,
}: {
  readonly task: BackgroundTask;
  readonly now: number;
  /**
   * The column this task belongs to, threaded down so the ⏹ can address its
   * stop through *that* column's run. The dock is a window-level surface and
   * clicking its tabs never moves pane focus, so "the focused pane" — the
   * default everywhere else — is exactly the wrong pane here whenever the tab
   * in front belongs to the other column of a split.
   */
  readonly pane: Pane;
}): ReactElement {
  const live = isTaskLive(task);
  /*
   * Whether this row opens into a conversation.
   *
   * Both halves are needed and neither implies the other: the provider has to
   * keep subagent transcripts at all, and *this* task has to be the kind that
   * has one. A row that fails either stays exactly as it was — a readout with a
   * stop button — rather than growing an affordance that opens onto nothing.
   */
  const openable = useApp(
    (s) =>
      taskHasTranscript(task) &&
      allLivePanes(s).some((one) => one.id === pane.id) &&
      canOpenSubagents(paneState(pane)),
  );

  const label = taskLabel(task);

  const phases = groupByPhase(task.workflowProgress);

  /*
   * A card, rather than a row in a run of rows.
   *
   * The pane holds items of wildly different heights — a one-line `Bash` beside
   * a workflow with four phases and twenty agents under it — and in a flat list
   * the phase tree of one item reads as if it belonged to the next. A border is
   * the cheapest thing that says where one piece of work stops.
   *
   * A settled card is recessed rather than raised: it is still readable, and
   * the contrast between the two halves does the work the "finished" heading
   * above it is also doing.
   */
  return (
    <li
      className={cn(
        // Square: this is a record of work the machine did, in the same family
        // as a diff or a block of tool output, and Sheet's shape rule is that
        // square is the tell for something the app did not write.
        'flex flex-col overflow-hidden rounded-none border',
        live ? 'border-line-strong bg-raised/40' : 'border-line bg-inset/40',
      )}
    >
      <div className="group flex items-start gap-2 px-2 py-1.5 hover:bg-raised/40">
        <StatusIcon task={task} />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          {openable ? (
            /*
             * The description is the control, rather than a separate "open"
             * button beside it. Clicking the name of a thing to see the thing
             * is what a list row means everywhere else, and the row already
             * carries one button — a second would put two targets a few pixels
             * apart, one of which stops the work.
             */
            <button
              type="button"
              onClick={() => openAgentTab(pane.id, task.id)}
              title={`Open ${label}${label === task.description ? '' : ` — ${task.description}`}`}
              className={cn(
                'min-w-0 flex-1 truncate text-left text-2xs hover:underline focus-visible:underline focus-visible:outline-none',
                !live && 'text-ink-faint',
              )}
            >
              {label}
            </button>
          ) : (
            <span
              // The description is the tooltip whenever it is not already the
              // label — a workflow's is a paragraph, and the row has one line.
              title={label === task.description ? undefined : task.description}
              className={cn('min-w-0 flex-1 truncate text-2xs', !live && 'text-ink-faint')}
            >
              {label}
            </span>
          )}
          <span className="shrink-0 font-mono text-3xs text-ink-faint tabular-nums">
            {formatElapsed(task, now)}
          </span>
        </div>
        <span className="truncate text-3xs text-ink-faint">{secondLine(task)}</span>
      </div>

        {live ? (
          <IconButton
            label={`Stop ${label}`}
            size="icon-xs"
            // Shown on hover of the row, like the dock tab's ✕: a control that only
            // appears once the pointer is on the thing it acts on, and that stays
            // reachable from the keyboard throughout.
            className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => void stopTask(task.id, pane)}
          >
            <CircleStopIcon />
          </IconButton>
        ) : null}
      </div>

      {phases.length > 0 ? (
        <Fold
          // Open while it is running, because a pane you opened to watch a
          // workflow should not need a click to show you the workflow. A close
          // is remembered against the task, so shutting one does not reopen on
          // the next progress message — of which there is one every few seconds.
          defaultOpen={live}
          rememberAs={`workflow:${task.id}`}
          className="border-t border-line/60 px-2 py-1"
          triggerClassName="pl-3 text-3xs"
          contentClassName="mt-0.5"
          summary={<span className="text-3xs">{summarizePhases(phases)}</span>}
        >
          <WorkflowPhases phases={phases} />
        </Fold>
      ) : null}
    </li>
  );
});

/* -------------------------------------------------------------------------- */
/* Workflow phases                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One phase's agents, in the order the script declared them.
 *
 * `index` and `title` are both absent for the agents of a workflow whose script
 * never called `phase()`. That is an ordinary shape rather than an error — a
 * small workflow has no phases — and it is drawn as a flat list, so the pane
 * never renders a heading for a phase that was never named.
 */
interface WorkflowPhaseGroup {
  readonly index: number | undefined;
  readonly title: string | undefined;
  readonly agents: readonly WorkflowAgent[];
}

/** An agent that will not change again. What the `n/m` on a phase counts. */
function isSettled(agent: WorkflowAgent): boolean {
  return agent.state === 'done' || agent.state === 'error';
}

/**
 * Group a workflow's agents under their phases.
 *
 * Pure, exported, and tested on its own, because this is the whole of the
 * feature's logic: the provider sends one flat array and the shape the mockup
 * asks for is entirely a reading of it.
 *
 * Two orderings, both deliberate. **Phases go in `phaseIndex` order**, which is
 * declaration order, so the column reads top to bottom the way the script does —
 * not in the order agents happened to start, which interleaves as soon as two
 * phases overlap. **Agents go in `index` order** within a phase, for the same
 * reason and so that a row never moves under a pointer as it settles.
 *
 * Unphased agents collect into a single trailing group. Trailing rather than
 * leading because a script that phases *some* of its work is nearly always
 * phasing the front of it.
 */
export function groupByPhase(
  agents: readonly WorkflowAgent[] | undefined,
): readonly WorkflowPhaseGroup[] {
  if (agents === undefined || agents.length === 0) return [];

  const phased = new Map<number, WorkflowAgent[]>();
  const titles = new Map<number, string>();
  const loose: WorkflowAgent[] = [];

  for (const agent of agents) {
    if (agent.phaseIndex === undefined) {
      loose.push(agent);
      continue;
    }
    const bucket = phased.get(agent.phaseIndex);
    if (bucket === undefined) phased.set(agent.phaseIndex, [agent]);
    else bucket.push(agent);
    // First title wins: every agent in a phase carries the same one, and a
    // later blank must not erase what an earlier entry established.
    if (agent.phaseTitle !== undefined && !titles.has(agent.phaseIndex)) {
      titles.set(agent.phaseIndex, agent.phaseTitle);
    }
  }

  const byIndex = (a: WorkflowAgent, b: WorkflowAgent): number => a.index - b.index;

  const groups: WorkflowPhaseGroup[] = [...phased.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, list]) => ({
      index,
      title: titles.get(index),
      agents: [...list].sort(byIndex),
    }));

  if (loose.length > 0) {
    groups.push({ index: undefined, title: undefined, agents: [...loose].sort(byIndex) });
  }
  return groups;
}

/** The collapsed line: enough to know whether opening it is worth it. */
function summarizePhases(phases: readonly WorkflowPhaseGroup[]): string {
  const agents = phases.reduce((total, phase) => total + phase.agents.length, 0);
  const named = phases.filter((phase) => phase.title !== undefined).length;
  const agentPart = `${String(agents)} ${agents === 1 ? 'agent' : 'agents'}`;
  if (named === 0) return agentPart;
  return `${String(named)} ${named === 1 ? 'phase' : 'phases'} · ${agentPart}`;
}

function WorkflowPhases({ phases }: { readonly phases: readonly WorkflowPhaseGroup[] }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      {phases.map((phase) => (
        <div key={phase.index ?? 'unphased'} className="flex flex-col">
          {phase.title === undefined ? null : <PhaseHeader phase={phase} />}
          <ul className="flex flex-col">
            {phase.agents.map((agent) => (
              <AgentRow key={agent.index} agent={agent} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * A phase's name, how far through it is, and a dot per agent.
 *
 * The dots are the mockup's own device and they earn their place: `3/3` says how
 * many are done and the strip says *which*, so a phase with one failure among
 * eight reads as a failure at a glance rather than as `7/8`.
 */
function PhaseHeader({ phase }: { readonly phase: WorkflowPhaseGroup }): ReactElement {
  const settled = phase.agents.filter(isSettled).length;

  return (
    <div className="flex items-center gap-2 rounded-sm bg-raised/40 px-1.5 py-0.5">
      <span className="min-w-0 flex-1 truncate text-3xs text-ink-muted">{phase.title}</span>
      <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
        {phase.agents.map((agent) => (
          <StatusDot
            key={agent.index}
            tone={agentTone(agent)}
            pulse={agent.state === 'progress'}
            className="size-1"
          />
        ))}
      </span>
      <span className="shrink-0 font-mono text-3xs text-ink-faint tabular-nums">
        {settled}/{phase.agents.length}
      </span>
    </div>
  );
}

/** The hue an agent's state maps to. Shared by the dot strip and the row. */
function agentTone(agent: WorkflowAgent): 'mint' | 'signal' | 'amber' | 'cyan' | 'neutral' {
  if (agent.state === 'error') {
    // A skip is not a fault. The workflow asked and the user declined, which is
    // an ordinary outcome wearing the same state as a crash.
    return agent.error === 'skipped by user' ? 'amber' : 'signal';
  }
  if (agent.state === 'done') return 'mint';
  if (agent.state === 'progress') return 'cyan';
  return 'neutral';
}

/**
 * One agent: what it was called, what it ran on, what it cost.
 *
 * The label takes the flexible width and everything else is `shrink-0`, so a
 * narrow rail eats into the label rather than dropping the numbers — the label
 * is the one part a reader can usually infer from its neighbours.
 */
function AgentRow({ agent }: { readonly agent: WorkflowAgent }): ReactElement {
  const model = agent.model === undefined ? undefined : modelLabel(agent.model);

  return (
    <li className="flex items-center gap-2 py-px pl-1.5" title={agentTitle(agent)}>
      <StatusDot tone={agentTone(agent)} pulse={agent.state === 'progress'} className="size-1" />
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-3xs',
          agent.state === 'error' ? 'text-signal/80' : 'text-ink-faint',
        )}
      >
        {agent.label}
      </span>
      {model === undefined ? null : (
        <span className="shrink-0 text-3xs text-ink-faint/70">{model}</span>
      )}
      {agent.tokens === undefined ? null : (
        <span className="shrink-0 font-mono text-3xs text-ink-faint tabular-nums">
          {formatTokens(agent.tokens)}
        </span>
      )}
      {agent.durationMs === undefined ? null : (
        <span className="w-12 shrink-0 text-right font-mono text-3xs text-ink-faint tabular-nums">
          {formatDuration(agent.durationMs)}
        </span>
      )}
    </li>
  );
}

/** Everything about an agent that will not fit on its line. */
function agentTitle(agent: WorkflowAgent): string {
  const parts: string[] = [agent.label];
  if (agent.agentType !== undefined) parts.push(agent.agentType);
  if (agent.model !== undefined) parts.push(agent.model);
  if (agent.isolation !== undefined) parts.push(agent.isolation);
  if (agent.cached === true) parts.push('reused from the workflow’s journal');
  if (agent.blocked === true) parts.push('blocked by a safety classifier');
  if (agent.error !== undefined) parts.push(agent.error);
  else if (agent.resultPreview !== undefined) parts.push(agent.resultPreview);
  else if (agent.promptPreview !== undefined) parts.push(agent.promptPreview);
  return parts.join(' · ');
}

/**
 * A model id, shortened to what distinguishes it.
 *
 * `claude-opus-5[1m]` in a column this narrow is a smear; `Opus 5 1M` is the
 * same fact. Unknown ids pass through whole rather than being forced through a
 * pattern that might be wrong about them — the provider adds models faster than
 * anyone updates a table, which is the argument the transcript's own provider
 * labels already make.
 */
function modelLabel(model: string): string {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?:\[(\w+)\])?$/.exec(
    model,
  );
  if (match === null) return model;
  const [, family, major, minor, window] = match;
  const name = `${(family as string)[0]?.toUpperCase() ?? ''}${(family as string).slice(1)}`;
  const version = minor === undefined ? major : `${major}.${minor}`;
  return `${name} ${version}${window === undefined ? '' : ` ${window.toUpperCase()}`}`;
}

function StatusIcon({ task }: { readonly task: BackgroundTask }): ReactElement {
  const className = 'mt-0.5 size-3 shrink-0';
  switch (task.status) {
    case 'running':
      return <PlayIcon className={cn(className, 'text-accent')} aria-label="running" />;
    case 'pending':
      return <ClockIcon className={cn(className, 'text-ink-faint')} aria-label="queued" />;
    case 'paused':
      return <PauseIcon className={cn(className, 'text-ink-faint')} aria-label="paused" />;
    case 'completed':
      return <CheckIcon className={cn(className, 'text-ink-faint')} aria-label="completed" />;
    default:
      return <XIcon className={cn(className, 'text-ink-faint')} aria-label={task.status} />;
  }
}

/**
 * What to call this row.
 *
 * A workflow is named, and its name is what anyone recognises it by —
 * `doctor-bug-fixes-build` is the thing you went looking for, while its
 * `description` is the sentence the script was launched with and runs to a
 * paragraph. So a workflow leads with its name and keeps the description as the
 * row's tooltip; everything else is titled by its description, as before.
 *
 * The provider only sets `workflowName` when the task really is a workflow — see
 * the SDK's `task_started` — so this needs no separate check on `kind`.
 */
function taskLabel(task: BackgroundTask): string {
  return task.workflowName ?? task.description;
}

/**
 * Friendly names for the task kinds we know, and the raw value for the rest.
 *
 * The protocol is explicit that {@link BackgroundTask.kind} is an open string
 * and that a UI should "map the ones it knows and show the raw value for the
 * rest" — a closed union here would either drop a kind the CLI added last week
 * or bucket it into `other` and lose the name. Which is also why the fallback
 * prints the raw discriminant rather than something reassuring: a row reading
 * `local_sandbox` is a fact, and one reading "Task" is a shrug.
 */
const KIND_LABELS: Readonly<Record<string, string>> = {
  local_bash: 'Shell',
  local_workflow: 'Workflow',
  local_subagent: 'Subagent',
  monitor: 'Monitor',
};

function kindLabel(task: BackgroundTask): string | undefined {
  // A subagent's *type* is the more specific fact and occupies the same slot:
  // "Explore" says everything "Subagent" does and more.
  if (task.subagentType !== undefined) return task.subagentType;
  if (task.kind.length === 0) return undefined;
  return KIND_LABELS[task.kind] ?? task.kind;
}

/**
 * The line under the label: what kind of thing this is, and how it is going.
 *
 * Built from whatever has arrived rather than from a fixed set of fields, since
 * a workflow reports none of the same things a backgrounded `sleep` does. What
 * it must never do is render an empty line — a row with a blank second line
 * reads as broken rather than as quiet.
 *
 * The kind comes first because it is the one part that is always true and never
 * changes, so the eye can find it in the same place down a list of rows whose
 * middles are all different lengths.
 */
function secondLine(task: BackgroundTask): string {
  const parts: string[] = [];

  const kind = kindLabel(task);
  if (kind !== undefined) parts.push(kind);

  if (isTaskLive(task)) {
    if (task.lastToolName !== undefined) parts.push(task.lastToolName);
    if (task.summary !== undefined) parts.push(task.summary);
  } else {
    parts.push(task.error ?? task.summary ?? task.status);
  }

  if (task.totalTokens !== undefined) parts.push(`${formatTokens(task.totalTokens)} tok`);
  /*
   * Carried by the protocol since the ledger was written and never drawn until
   * now. For a workflow it is the closest thing available to "how much work was
   * this" — the SDK reports no agent count, so tool calls are the measure of
   * size that actually arrives.
   */
  if (task.toolUses !== undefined && task.toolUses > 0) {
    parts.push(`${String(task.toolUses)} ${task.toolUses === 1 ? 'tool' : 'tools'}`);
  }
  if (task.outputFile !== undefined && !isTaskLive(task)) parts.push(task.outputFile);

  // The status is the one thing always knowable, so it is the fallback rather
  // than a blank.
  return parts.length > 0 ? parts.join(' · ') : task.status;
}

function formatTokens(total: number): string {
  if (total < 1_000) return String(total);
  if (total < 1_000_000) return `${(total / 1_000).toFixed(1)}k`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

/**
 * How long it has been going.
 *
 * The provider's own measure when there is one, because it times the work rather
 * than the time since Artemis first heard of it — which differ by however long
 * the task ran before its first message arrived. A settled row freezes at its
 * end; a live one counts from `startedAt` against the ticking clock.
 */
function formatElapsed(task: BackgroundTask, now: number): string {
  const ms = isTaskLive(task)
    ? Math.max(task.durationMs ?? 0, now - task.startedAt)
    : (task.durationMs ?? (task.endedAt ?? now) - task.startedAt);

  return formatDuration(ms);
}

/** A span of milliseconds, in the pane's own shorthand. */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * A clock that runs only while something is live.
 *
 * Stopping it when nothing is running is not a micro-optimisation: a dock left
 * open on a settled list would otherwise re-render every second for the rest of
 * the session, and every one of those renders would produce identical text.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/**
 * This column's rows, subscribed so the dock redraws as they change.
 *
 * `useStore` on the pane's own store rather than on the window's: a progress
 * message must notify this list and nothing else, which is the same rule the
 * transcript follows and the reason pane state is a separate store at all.
 */
const NO_TASKS: readonly BackgroundTask[] = [];

function usePaneTasks(pane: Pane | undefined): readonly BackgroundTask[] {
  // Subscribed by hand rather than through `usePane`, because a column can close
  // between the strip being computed and this rendering — so the pane is
  // `undefined` on some renders, and a hook cannot be skipped on those.
  const [tasks, setTasks] = useState<readonly BackgroundTask[]>(() =>
    pane === undefined ? NO_TASKS : paneState(pane).tasks,
  );

  useEffect(() => {
    if (pane === undefined) {
      setTasks(NO_TASKS);
      return;
    }
    setTasks(paneState(pane).tasks);
    return pane.store.subscribe(() => setTasks(paneState(pane).tasks));
  }, [pane]);

  return tasks;
}
