/**
 * What a provider process has delegated, kept in one place.
 * ============================================================================
 *
 * The CLI says five different things about a task and none of them is the whole
 * picture:
 *
 * | Message | What it is | What only it carries |
 * | --- | --- | --- |
 * | `task_started` | edge | the prompt, the agent type, the workflow's name |
 * | `task_progress` | level-ish | tokens, tool count, the tool it is using now |
 * | `task_updated` | patch | pause, resumption, the error text |
 * | `task_notification` | edge | how it ended, the output file, final usage |
 * | `background_tasks_changed` | level | **which tasks are live at all** |
 *
 * So a row is a merge, and this module is the merge. It is deliberately a plain
 * object with no I/O in it: the hard part is the state machine, and a state
 * machine that can be driven by a list of literals in a test is one that can be
 * argued with.
 *
 * ## Membership comes from the level, and nothing else
 *
 * The SDK is explicit that `background_tasks_changed` is a level with replace
 * semantics, that it exists so a consumer "cannot wedge a stale running
 * indicator" by missing an edge, and that its ordering against the edges for the
 * same transition is unspecified. Everything here follows from taking that
 * seriously:
 *
 *  - A task named by the level is live. A task the level has stopped naming has
 *    settled, whether or not its `task_notification` has arrived yet.
 *  - Edges may arrive for a task the level has never mentioned — a foreground
 *    subagent is delegated work too, and it is not *background* work, so it
 *    never appears in that payload. Those rows exist and are live from their
 *    own `task_started` until their own notification settles them.
 *  - An edge may arrive before the level, or after. Both are ordinary; neither
 *    creates a second row, because everything keys on `task_id`.
 *
 * ## What this is *not* allowed to decide
 *
 * Whether the provider process may be closed. That question is answered by the
 * raw level alone, in `ClaudeProcess`, and this file is not consulted — which is
 * not a tidiness rule but the whole reason background work survives a turn. A
 * foreground subagent's row is live here and is not background work; letting
 * display state feed retention would pin a CLI open for a task that was never
 * outstanding in the sense retention means.
 *
 * ## Settled rows stay, and are bounded
 *
 * A finished task's row is the most useful it has ever been — what it cost, what
 * it said, where its output went — so it stays, marked. The oldest are evicted
 * past {@link SETTLED_LIMIT}, which is the same policy and the same reasoning as
 * the terminal registry's exited-session cap: worth keeping for the one the
 * reader is looking at, not for the ninety before it.
 */

import type { BackgroundTask, BackgroundTaskStatus, WorkflowAgent } from '@rx-artemis/protocol';

/**
 * How many settled rows to keep.
 *
 * Eight, matching the terminal registry's `MAX_EXITED`. The number is not
 * precious; that it is *bounded* is, because a workflow's thousand-agent cap
 * means an unbounded ledger is a memory leak with a plausible path to it.
 */
export const SETTLED_LIMIT = 8;

/** A task message, as far as this module is concerned. */
interface TaskMessageLike {
  readonly type?: unknown;
  readonly subtype?: unknown;
}

/**
 * The provider's task states, mapped onto ours.
 *
 * `killed` and `stopped` are one state here: from outside, work that ended
 * because something asked it to. `pending` is kept apart from `running` because
 * a queued task and a working one look different in a list and a reader can act
 * on the difference.
 */
function mapStatus(raw: unknown): BackgroundTaskStatus | undefined {
  switch (raw) {
    case 'pending':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
      return raw;
    case 'killed':
    case 'stopped':
      return 'stopped';
    default:
      return undefined;
  }
}

/** Read a string field, or nothing. Provider payloads are not to be trusted into casts. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The usage triple, which three different messages carry identically. */
function usageOf(value: unknown): Partial<BackgroundTask> {
  if (typeof value !== 'object' || value === null) return {};
  const usage = value as { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown };
  return {
    ...(num(usage.total_tokens) === undefined ? {} : { totalTokens: num(usage.total_tokens) }),
    ...(num(usage.tool_uses) === undefined ? {} : { toolUses: num(usage.tool_uses) }),
    ...(num(usage.duration_ms) === undefined ? {} : { durationMs: num(usage.duration_ms) }),
  };
}

/**
 * A workflow's own account of its agents, off `task_progress`.
 *
 * Returns `undefined` — meaning "say nothing, keep what you had" — rather than
 * an empty patch, so the caller can spread the result and have absence retain.
 * That distinction is the whole point of this function and is why it is not
 * written in the shape of {@link usageOf} beside it: for usage, a missing field
 * and an unchanged field are the same thing; here they are opposites.
 *
 * ## What is dropped, and why it is dropped here
 *
 * The array also carries `workflow_log` entries, which are the script's own
 * `log()` output. The CLI filters them out of the SDK payload already, so this
 * is belt and braces — but it is cheap, and a log line rendered as an agent row
 * with no label and no state would be a puzzle rather than a bug report.
 *
 * An entry with no `label`, or no numeric `index`, is dropped too. Both are
 * what the pane keys and groups by, and a row that cannot be keyed cannot be
 * drawn stably next to its siblings.
 */
function workflowProgressOf(value: unknown): Partial<BackgroundTask> | undefined {
  if (!Array.isArray(value)) return undefined;

  const agents: WorkflowAgent[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry['type'] !== 'workflow_agent') continue;

    const index = num(entry['index']);
    const label = str(entry['label']);
    const state = str(entry['state']);
    if (index === undefined || label === undefined || state === undefined) continue;

    agents.push({
      index,
      label,
      state,
      ...(num(entry['phaseIndex']) === undefined ? {} : { phaseIndex: num(entry['phaseIndex']) }),
      ...(str(entry['phaseTitle']) === undefined ? {} : { phaseTitle: str(entry['phaseTitle']) }),
      ...(str(entry['agentId']) === undefined ? {} : { agentId: str(entry['agentId']) }),
      ...(str(entry['agentType']) === undefined ? {} : { agentType: str(entry['agentType']) }),
      ...(str(entry['model']) === undefined ? {} : { model: str(entry['model']) }),
      ...(str(entry['isolation']) === undefined ? {} : { isolation: str(entry['isolation']) }),
      ...(entry['cached'] === true ? { cached: true } : {}),
      ...(entry['blocked'] === true ? { blocked: true } : {}),
      ...(str(entry['error']) === undefined ? {} : { error: str(entry['error']) }),
      ...(num(entry['tokens']) === undefined ? {} : { tokens: num(entry['tokens']) }),
      ...(num(entry['toolCalls']) === undefined ? {} : { toolCalls: num(entry['toolCalls']) }),
      ...(num(entry['durationMs']) === undefined ? {} : { durationMs: num(entry['durationMs']) }),
      ...(num(entry['queuedAt']) === undefined ? {} : { queuedAt: num(entry['queuedAt']) }),
      ...(num(entry['startedAt']) === undefined ? {} : { startedAt: num(entry['startedAt']) }),
      ...(num(entry['lastProgressAt']) === undefined
        ? {}
        : { lastProgressAt: num(entry['lastProgressAt']) }),
      ...(str(entry['promptPreview']) === undefined
        ? {}
        : { promptPreview: str(entry['promptPreview']) }),
      ...(str(entry['resultPreview']) === undefined
        ? {}
        : { resultPreview: str(entry['resultPreview']) }),
    });
  }

  /*
   * An array that held only logs is still an answer: the workflow said "here is
   * everything", and everything was nothing an agent row could be made of. That
   * is a genuine empty rather than silence, so it is written through — a
   * workflow with no agents yet should not inherit the last one's.
   */
  return { workflowProgress: agents };
}

/**
 * The tasks one provider process has delegated.
 *
 * One per {@link ClaudeProcess}, and it dies with it: the SDK emits no level at
 * startup, so rows carried across a restart would be claims about work inside a
 * process that no longer exists.
 */
export class TaskLedger {
  readonly #now: () => number;
  /** Insertion-ordered, which is the order the rows are shown in. */
  readonly #rows = new Map<string, BackgroundTask>();
  /**
   * Ids the level has ever named — the rows whose disappearance from it means
   * something.
   *
   * Without this, a foreground subagent's row would be settled by the first
   * level payload that arrived for anything else, since it is never in one.
   */
  readonly #fromLevel = new Set<string>();
  /** True when {@link snapshot} would differ from the last one taken. */
  #dirty = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Feed the ledger one provider message.
   *
   * @returns whether anything changed — the caller emits only when it did, so a
   *          message about a task nobody asked about costs one map lookup and
   *          no event.
   */
  observe(message: TaskMessageLike): boolean {
    if (message.type !== 'system') return false;

    switch (message.subtype) {
      case 'background_tasks_changed':
        return this.#level(message);
      case 'task_started':
        return this.#started(message);
      case 'task_progress':
        return this.#progress(message);
      case 'task_updated':
        return this.#updated(message);
      case 'task_notification':
        return this.#settled(message);
      default:
        return false;
    }
  }

  /**
   * Every row, running first, in the order they were first heard of.
   *
   * The **emitting** read: it clears {@link dirty}, because the only caller is
   * about to put what it returns onto the stream. Anything reading the ledger
   * for another reason wants {@link peek}.
   */
  snapshot(): readonly BackgroundTask[] {
    this.#dirty = false;
    return this.peek();
  }

  /**
   * The same rows, without claiming to have delivered them.
   *
   * For a reader answering a poll rather than filling an event — the reload path
   * in particular, which asks the ledger directly precisely because no event is
   * going to carry these rows. It must not clear {@link dirty}: doing so would
   * mark an unsent change as sent, and the `background.tasks` event that change
   * was owed would never be emitted. Every window's rows would then sit frozen
   * until something unrelated dirtied the ledger again — a poll silently
   * breaking the live stream it exists to back up.
   */
  peek(): readonly BackgroundTask[] {
    return [...this.#rows.values()];
  }

  /** Whether anything has changed since the last {@link snapshot}. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** True when at least one row is still going. For diagnostics, not retention. */
  get liveCount(): number {
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.status === 'pending' || row.status === 'running' || row.status === 'paused') {
        count += 1;
      }
    }
    return count;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Membership, from the one signal that carries it.
   *
   * Two directions, and the second is the one that matters. A task named here
   * and not known is a row this ledger never saw start — a task backgrounded
   * mid-flight, or an edge that has not arrived yet — so it is created from what
   * the level carries. A task *known and live* that the level has stopped naming
   * has ended, whatever its edges have or have not said: that is exactly the
   * "cannot wedge a stale indicator" property, and dropping it in favour of
   * waiting for a notification would give it up.
   *
   * Settled rows are not resurrected by their absence, and the level never names
   * a foreground task, so a row that settled ten seconds ago is left alone.
   */
  #level(message: TaskMessageLike): boolean {
    const raw = (message as { tasks?: unknown }).tasks;
    if (!Array.isArray(raw)) return false;

    let changed = false;
    const named = new Set<string>();

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const task = entry as { task_id?: unknown; task_type?: unknown; description?: unknown };
      const id = str(task.task_id);
      if (id === undefined) continue;
      named.add(id);

      const existing = this.#rows.get(id);
      if (existing === undefined) {
        this.#put(id, {
          id,
          kind: str(task.task_type) ?? 'task',
          description: str(task.description) ?? 'unnamed task',
          status: 'running',
          startedAt: this.#now(),
        });
        changed = true;
        continue;
      }
      // A settled row that the level names again is running once more — the
      // provider is the authority on that, and refusing it would leave a
      // struck-through row for work that is going.
      if (!isLive(existing)) {
        this.#put(id, { ...existing, status: 'running', endedAt: undefined });
        changed = true;
      }
    }

    for (const [id, row] of this.#rows) {
      if (named.has(id) || !isLive(row)) continue;
      // Only rows the level is responsible for. A foreground subagent is never
      // in that payload, so its absence says nothing about it.
      if (!this.#fromLevel.has(id)) continue;
      this.#put(id, { ...row, status: 'stopped', endedAt: this.#now() });
      changed = true;
    }

    for (const id of named) this.#fromLevel.add(id);
    if (changed) this.#dirty = true;
    return changed;
  }

  /**
   * The row this message is about, or a fresh one.
   *
   * Every handler below is "take what we knew and lay this message's fields over
   * it", so the base has to be a whole row rather than a set of defaults mixed
   * in among the overrides — which is what it was first written as, and which
   * silently made `existing` win over the very fields the message is the
   * authority on.
   */
  #base(id: string): BackgroundTask {
    return (
      this.#rows.get(id) ?? {
        id,
        kind: 'task',
        description: 'unnamed task',
        status: 'running',
        startedAt: this.#now(),
      }
    );
  }

  #started(message: TaskMessageLike): boolean {
    const task = message as {
      task_id?: unknown;
      description?: unknown;
      subagent_type?: unknown;
      task_type?: unknown;
      workflow_name?: unknown;
      prompt?: unknown;
      skip_transcript?: unknown;
    };
    const id = str(task.task_id);
    if (id === undefined) return false;

    this.#put(id, {
      ...this.#base(id),
      ...(str(task.task_type) === undefined ? {} : { kind: str(task.task_type)! }),
      ...(str(task.description) === undefined ? {} : { description: str(task.description)! }),
      ...(str(task.subagent_type) === undefined ? {} : { subagentType: str(task.subagent_type) }),
      ...(str(task.workflow_name) === undefined ? {} : { workflowName: str(task.workflow_name) }),
      ...(str(task.prompt) === undefined ? {} : { prompt: str(task.prompt) }),
      ...(task.skip_transcript === true ? { ambient: true } : {}),
    });
    this.#dirty = true;
    return true;
  }

  #progress(message: TaskMessageLike): boolean {
    const task = message as {
      task_id?: unknown;
      description?: unknown;
      subagent_type?: unknown;
      usage?: unknown;
      last_tool_name?: unknown;
      summary?: unknown;
      workflow_progress?: unknown;
    };
    const id = str(task.task_id);
    if (id === undefined) return false;

    /*
     * Progress on a settled row does not revive it. The notification is the
     * authority on how something ended, and a progress message arriving after
     * one is a message that took a different path through the CLI rather than
     * news that the work is going again — unlike the level, which is the
     * provider stating membership outright.
     */
    this.#put(id, {
      ...this.#base(id),
      ...usageOf(task.usage),
      ...(str(task.description) === undefined ? {} : { description: str(task.description)! }),
      ...(str(task.subagent_type) === undefined ? {} : { subagentType: str(task.subagent_type) }),
      ...(str(task.last_tool_name) === undefined ? {} : { lastToolName: str(task.last_tool_name) }),
      ...(str(task.summary) === undefined ? {} : { summary: str(task.summary) }),
      /*
       * Absent means "unchanged", not "empty" — the one field on this message
       * where those differ. The provider sends the whole array on a state change
       * and at most every ten seconds during steady progress, omitting it in
       * between, so writing `undefined` through would blank the pane several
       * times a minute and refill it. Spreading nothing is what retains it.
       */
      ...(workflowProgressOf(task.workflow_progress) ?? {}),
    });
    this.#dirty = true;
    return true;
  }

  /** A patch of "wire-safe TaskState fields that changed", merged as the SDK asks. */
  #updated(message: TaskMessageLike): boolean {
    const id = str((message as { task_id?: unknown }).task_id);
    const patch = (message as { patch?: unknown }).patch;
    if (id === undefined || typeof patch !== 'object' || patch === null) return false;

    // A patch for a task nothing has ever mentioned is not enough to build a row
    // from — it carries no description and no kind — so it is dropped rather
    // than turned into a row reading "unnamed task".
    const existing = this.#rows.get(id);
    if (existing === undefined) return false;

    const fields = patch as {
      status?: unknown;
      description?: unknown;
      end_time?: unknown;
      error?: unknown;
    };
    const status = mapStatus(fields.status);

    this.#put(id, {
      ...existing,
      ...(status === undefined ? {} : { status }),
      ...(str(fields.description) === undefined ? {} : { description: str(fields.description)! }),
      ...(str(fields.error) === undefined ? {} : { error: str(fields.error) }),
      // `end_time` is the provider's own clock, so it is not written into
      // `endedAt` — which exists to be compared against `Date.now()`. What it is
      // good for is knowing that the task *has* ended.
      ...(status !== undefined && !liveStatus(status) ? { endedAt: this.#now() } : {}),
    });
    this.#dirty = true;
    return true;
  }

  #settled(message: TaskMessageLike): boolean {
    const task = message as {
      task_id?: unknown;
      status?: unknown;
      output_file?: unknown;
      summary?: unknown;
      usage?: unknown;
      skip_transcript?: unknown;
    };
    const id = str(task.task_id);
    if (id === undefined) return false;

    this.#put(id, {
      ...this.#base(id),
      ...usageOf(task.usage),
      // The one message that is the authority on how a task ended, so its
      // status is written unconditionally rather than merged.
      status: mapStatus(task.status) ?? 'completed',
      endedAt: this.#now(),
      ...(str(task.output_file) === undefined ? {} : { outputFile: str(task.output_file) }),
      ...(str(task.summary) === undefined ? {} : { summary: str(task.summary) }),
      ...(task.skip_transcript === true ? { ambient: true } : {}),
    });
    this.#evictSettled();
    this.#dirty = true;
    return true;
  }

  #put(id: string, row: BackgroundTask): void {
    this.#rows.set(id, row);
  }

  /**
   * Drop the oldest settled rows past the cap.
   *
   * By insertion order rather than by end time, because the map's order is the
   * order the list is drawn in: evicting by a different measure would take a row
   * from the middle of what the reader is looking at.
   */
  #evictSettled(): void {
    const settled = [...this.#rows.values()].filter((row) => !isLive(row));
    for (const row of settled.slice(0, Math.max(0, settled.length - SETTLED_LIMIT))) {
      this.#rows.delete(row.id);
    }
  }
}

function liveStatus(status: BackgroundTaskStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

function isLive(task: BackgroundTask): boolean {
  return liveStatus(task.status);
}
