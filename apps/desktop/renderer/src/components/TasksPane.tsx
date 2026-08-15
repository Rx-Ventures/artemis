/**
 * What this conversation has delegated, and how it is going.
 * ============================================================================
 *
 *     ⏵ Explore   auth call sites          1m12s  ⏹
 *       Grep · 24.1k tok · 7 tools
 *     ⏵ review-changes (workflow)          3m40s  ⏹
 *       running · 310k tok
 *     ⏹ code-review                        2m01s
 *       completed · /tmp/task-4.md
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
import type { BackgroundTask } from '@rx-artemis/protocol';
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

  return (
    <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1" aria-label="Delegated work">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} now={now} pane={pane} />
      ))}
    </ul>
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

  return (
    <li className="group flex items-start gap-2 px-2 py-1 hover:bg-raised/30">
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
    </li>
  );
});

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
