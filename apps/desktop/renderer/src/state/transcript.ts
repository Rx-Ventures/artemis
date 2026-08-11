/**
 * The transcript model.
 *
 * This is the renderer's hot path and the one place where a naive React
 * implementation falls over: a fast provider emits a `text.delta` every few
 * milliseconds, and putting that in component state re-renders the whole
 * transcript per token — O(items) work per token, which is O(n²) over a turn.
 *
 * So the transcript lives outside React, in this plain-TS store, and React
 * subscribes to it at two different granularities:
 *
 *  - **the list** — an array of item ids, which changes only when an item is
 *    added or removed. Adding a token does not touch it.
 *  - **one item** — each rendered item subscribes to *its own id*, so a delta
 *    notifies exactly one leaf component.
 *  - **one activity group** — runs of consecutive machinery (thinking blocks
 *    and tool calls) are folded into a single summarised row, because grouping
 *    is about neighbours and a component here is never allowed to see its
 *    neighbours. See {@link ActivityGroup}, which explains why that constraint
 *    forces the work down here and how it stays off the per-token path.
 *
 * Deltas are appended to a mutable string buffer and coalesced: a burst of
 * fifty tokens produces one snapshot and one notification on the next frame,
 * not fifty. Snapshots are immutable and reference-stable between flushes,
 * which is exactly the contract `useSyncExternalStore` wants.
 *
 * The model is framework-free and synchronous when handed a synchronous
 * scheduler, which is how it is tested.
 */

import type {
  AgentError,
  AgentEvent,
  Attachment,
  JsonObject,
  JsonValue,
  PermissionRequest,
  RunEndReason,
  StopReason,
  ToolEndStatus,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { classifyTool, type ActivityCounts, type ToolCategory } from '../lib/tools';

/* -------------------------------------------------------------------------- */
/* Items                                                                      */
/* -------------------------------------------------------------------------- */

interface ItemBase {
  readonly id: string;
  readonly ts: number;
}

/** Something the user typed. `pending` until the provider echoes it back. */
export interface UserItem extends ItemBase {
  readonly kind: 'user';
  readonly text: string;
  readonly pending: boolean;
  /**
   * Images sent with the message.
   *
   * The full attachments, base64 and all, kept for as long as the transcript
   * holds the turn — which is what lets the thumbnail render without a fetch,
   * and is the reason `IMAGE_ATTACHMENT_LIMITS` is as small as it is. Replayed
   * history has none: the providers' stored transcripts record what the model
   * was sent, and reconstructing a thumbnail from that is a different feature.
   */
  readonly attachments?: readonly Attachment[];
}

/** One assistant text block, streamed or whole. */
export interface AssistantItem extends ItemBase {
  readonly kind: 'assistant';
  readonly messageId: string;
  readonly blockIndex: number;
  readonly text: string;
  readonly streaming: boolean;
  readonly stopReason?: StopReason;
  readonly replay?: boolean;
  readonly synthetic?: boolean;
  readonly agentId?: string;
}

/** Extended thinking. Collapsed by default in the UI. */
export interface ThinkingItem extends ItemBase {
  readonly kind: 'thinking';
  readonly messageId: string;
  readonly blockIndex: number;
  readonly text: string;
  readonly streaming: boolean;
  readonly redacted: boolean;
  readonly agentId?: string;
}

/** Status of a tool call as the transcript sees it. */
export type ToolStatus = 'running' | ToolEndStatus;

export interface ToolItem extends ItemBase {
  readonly kind: 'tool';
  readonly toolCallId: string;
  readonly name: string;
  readonly title?: string;
  readonly input: JsonObject;
  readonly status: ToolStatus;
  readonly result?: JsonValue;
  readonly resultText?: string;
  readonly error?: AgentError;
  readonly durationMs?: number;
  readonly agentId?: string;
  readonly parentToolCallId?: string;
}

/** A permission prompt, kept in the transcript so the decision is a record. */
export interface PermissionItem extends ItemBase {
  readonly kind: 'permission';
  readonly requestId: string;
  readonly request: PermissionRequest;
  readonly state: 'pending' | 'allowed' | 'denied';
  readonly note?: string;
}

/** Engine-level chatter: session start, re-attach, dropped events. */
export interface NoticeItem extends ItemBase {
  readonly kind: 'notice';
  readonly level: 'info' | 'warn' | 'error';
  readonly text: string;
  readonly detail?: string;
}

/** The terminal card for a run. */
export interface RunEndItem extends ItemBase {
  readonly kind: 'run-end';
  readonly reason: RunEndReason;
  readonly error?: AgentError;
  readonly usage?: UsageSnapshot;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly result?: string;
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | NoticeItem
  | RunEndItem;

/* -------------------------------------------------------------------------- */
/* Activity groups                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A run of consecutive machinery — thinking blocks and tool calls — summarised.
 *
 * The transcript draws one marker per group — "Ran 36 commands, read 6 files"
 * — instead of one row per call, because a turn that touches forty files is
 * forty rows of machinery between two sentences of actual answer.
 *
 * ## Why thinking is in here too
 *
 * Grouping tool calls alone fixed half the problem and made the other half
 * obvious. A working turn does not emit a clean burst of calls: it thinks,
 * calls a tool, thinks about the result, calls the next one. Folding only the
 * calls leaves that as `thinking / tool / thinking / tool / thinking …` — the
 * marker collapses each run of one, and the reader is back to a screen of rows
 * for what is a single line of reasoning with some work hanging off it.
 *
 * So a run is *machinery*, not tools, and the whole stretch between two things
 * someone actually said folds into one row.
 *
 * A run with no tool call in it is left alone: a thinking block on its own is
 * the model's reasoning before it answers, it already renders as one compact
 * sage row, and burying it behind a marker would cost a click to reach the only
 * thing in there.
 *
 * ## Why this is computed here and not in the component
 *
 * The transcript's performance contract says the list hands React ids and
 * nothing else, so a row can never see its neighbours. Grouping is *inherently*
 * about neighbours, so it cannot happen in a row — a component that looked
 * left to decide whether it starts a group would have to read items during
 * render, which is the exact thing that makes streaming O(items) per token.
 *
 * So the model does it, and it stays cheap because of when it runs:
 *
 *  - **membership** is rebuilt only on a structural change, alongside the
 *    `ids` snapshot that is already O(items). A token never triggers it.
 *  - **the summary** is O(members) and holds no text, so a thinking delta
 *    inside a group rebuilds a handful of counters that compare equal and
 *    notifies nobody. What the reader sees of that delta is the member card,
 *    which subscribes to its own id like every other row.
 *
 * Snapshots are reference-stable: an unchanged group keeps its object identity
 * across flushes, which is what `useSyncExternalStore` requires and what stops
 * a marker re-rendering every time a sibling streams.
 */
export interface ActivityGroup {
  /** `g:` + the first member's id. Distinct from every item id by prefix. */
  readonly id: string;
  /** Member item ids, in transcript order. Holds at least one tool call. */
  readonly ids: readonly string[];
  /** When the burst started — the first member's timestamp. */
  readonly ts: number;
  /** How many calls of each kind, for the summary line. */
  readonly counts: ActivityCounts;
  /** Thinking blocks folded in. The marker says *that* they are here, not how many. */
  readonly thinking: number;
  /** Calls still running. Non-zero means the marker reads in present tense. */
  readonly running: number;
  /** Calls that errored or were denied. Never hidden behind a collapsed row. */
  readonly failed: number;
  /**
   * A thinking block is still arriving.
   *
   * Kept apart from {@link running} rather than folded into it because the two
   * drive different things: the marker pulses for either, but only a running
   * *call* may put the summary in the present tense. A group whose commands
   * have all finished while the model thinks about them did run them, and
   * "Running 2 commands" would be a lie about work that is over.
   */
  readonly streaming: boolean;
}

/** True for a row id that names an {@link ActivityGroup} rather than an item. */
export function isGroupId(id: string): boolean {
  return id.startsWith('g:');
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/** How a coalesced flush gets deferred. Injectable so tests can run it now. */
export type Scheduler = (flush: () => void) => void;

/** One flush per animation frame — the display cannot show more than that. */
export const frameScheduler: Scheduler = (flush) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush());
  else setTimeout(flush, 16);
};

/** Flush immediately. Used by tests. */
export const syncScheduler: Scheduler = (flush) => flush();

type Listener = () => void;

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

export class TranscriptModel {
  private readonly schedule: Scheduler;

  private ids: string[] = [];
  private idsSnapshot: readonly string[] = EMPTY_IDS;
  private items = new Map<string, TranscriptItem>();

  /**
   * The renderable sequence: `ids` with runs of machinery folded into groups.
   *
   * Rebuilt only on a structural change — see {@link ActivityGroup}. `groupOf`
   * is the reverse index, so a changed member can find its group in O(1)
   * instead of a scan.
   */
  private rowsSnapshot: readonly string[] = EMPTY_IDS;
  private groupMembers = new Map<string, readonly string[]>();
  private groupOf = new Map<string, string>();
  private groupSnapshots = new Map<string, ActivityGroup>();
  private groupListeners = new Map<string, Set<Listener>>();

  /** Authoritative text for streaming blocks; folded into snapshots on flush. */
  private buffers = new Map<string, string>();

  /** Ordered block ids per assistant message, for `text.complete` without an index. */
  private messageBlocks = new Map<string, string[]>();

  /** Optimistic user items still waiting for the provider to echo them. */
  private unconfirmedUser: string[] = [];

  /**
   * Indexes of open work, so settling a turn is O(open) rather than O(items).
   * A long transcript should not get slower every time a tool starts.
   */
  private streaming = new Set<string>();
  private openTools = new Set<string>();

  private dirty = new Set<string>();
  private structural = false;
  private pending = false;

  private listListeners = new Set<Listener>();
  private itemListeners = new Map<string, Set<Listener>>();

  private counter = 0;
  private lastSeq: number | null = null;

  constructor(schedule: Scheduler = frameScheduler) {
    this.schedule = schedule;
  }

  /* ---- reads ---------------------------------------------------------- */

  /** Stable array of item ids. New identity only on structural change. */
  getListSnapshot = (): readonly string[] => this.idsSnapshot;

  /**
   * Stable array of *row* ids — the list the transcript actually renders.
   *
   * Same as {@link getListSnapshot} except that a run of consecutive machinery
   * — thinking blocks and tool calls — appears as one `g:` group id. Changes
   * identity on exactly the same beat, so it costs a subscription and no extra
   * render.
   */
  getRowsSnapshot = (): readonly string[] => this.rowsSnapshot;

  /** Stable snapshot of one item. New identity only when that item changed. */
  getItem = (id: string): TranscriptItem | undefined => this.items.get(id);

  /**
   * Stable snapshot of one activity group.
   *
   * Built on first read and cached; the cache entry survives until the group's
   * membership or one of its members changes, which is what makes the identity
   * safe to hand `useSyncExternalStore`.
   */
  getGroup = (id: string): ActivityGroup | undefined => {
    const cached = this.groupSnapshots.get(id);
    if (cached) return cached;
    const built = this.buildGroup(id);
    if (built) this.groupSnapshots.set(id, built);
    return built;
  };

  get length(): number {
    return this.ids.length;
  }

  /** True once anything at all has been rendered — drives the empty state. */
  get isEmpty(): boolean {
    return this.ids.length === 0;
  }

  /* ---- subscriptions -------------------------------------------------- */

  subscribeList = (listener: Listener): (() => void) => {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  };

  subscribeItem = (id: string, listener: Listener): (() => void) => {
    let set = this.itemListeners.get(id);
    if (!set) {
      set = new Set();
      this.itemListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.itemListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.itemListeners.delete(id);
    };
  };

  subscribeGroup = (id: string, listener: Listener): (() => void) => {
    let set = this.groupListeners.get(id);
    if (!set) {
      set = new Set();
      this.groupListeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const current = this.groupListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.groupListeners.delete(id);
    };
  };

  /* ---- writes --------------------------------------------------------- */

  /** Add the user's message optimistically, before the round-trip returns. */
  pushUserMessage(text: string, attachments?: readonly Attachment[]): string {
    const id = `u:${++this.counter}`;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'user',
      text,
      pending: true,
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    });
    this.unconfirmedUser.push(id);
    return id;
  }

  /**
   * Mark an optimistic user message as delivered.
   *
   * {@link pushUserMessage} renders the prompt before the round-trip returns
   * and flags it `pending`, which the UI draws dimmed. Something has to clear
   * that flag, and the provider echo cannot: the Claude mapper deliberately
   * drops the echo of Artemis's own prompt (the renderer already drew it), so
   * `completeUserText`'s reconciliation branch never runs for a live turn and
   * every message the user ever sent would stay dimmed for the life of the
   * window, with its id accumulating in `unconfirmedUser` forever.
   *
   * So confirmation happens at the point Artemis actually knows the text was
   * delivered — when `runs.start` / `runs.send` resolves. A prompt whose call
   * *failed* is deliberately left pending: dimmed then means what it says.
   */
  confirmUserMessage(id: string): void {
    const index = this.unconfirmedUser.indexOf(id);
    if (index >= 0) this.unconfirmedUser.splice(index, 1);
    const existing = this.items.get(id);
    if (existing?.kind !== 'user' || !existing.pending) return;
    this.replace(id, { ...existing, pending: false });
  }

  /** Add an engine-level note. */
  note(level: NoticeItem['level'], text: string, detail?: string): string {
    const id = `n:${++this.counter}`;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'notice',
      level,
      text,
      ...(detail === undefined ? {} : { detail }),
    });
    return id;
  }

  /** Record the user's answer to a permission prompt. */
  resolvePermission(requestId: string, state: 'allowed' | 'denied', note?: string): void {
    const id = `p:${requestId}`;
    const existing = this.items.get(id);
    if (!existing || existing.kind !== 'permission') return;
    this.replace(id, {
      ...existing,
      state,
      ...(note === undefined ? {} : { note }),
    });
  }

  /**
   * Write a terminal card for a run that never produced a `run.end`.
   *
   * The only legitimate caller is the store, when `runs.start` fails outright:
   * there is no event stream to carry the real terminal event, and leaving the
   * transcript open forever is worse than recording the failure locally.
   */
  localRunEnd(reason: RunEndReason, error?: AgentError): void {
    this.settleStreaming();
    this.failOpenToolCalls(reason);
    const id = `e:${++this.counter}`;
    this.insert({
      id,
      ts: Date.now(),
      kind: 'run-end',
      reason,
      ...(error === undefined ? {} : { error }),
    });
    this.lastSeq = null;
  }

  /** Drop everything. Used when starting a new session. */
  reset(): void {
    this.ids = [];
    this.items = new Map();
    this.rowsSnapshot = EMPTY_IDS;
    this.groupMembers = new Map();
    this.groupOf = new Map();
    this.groupSnapshots = new Map();
    this.buffers = new Map();
    this.messageBlocks = new Map();
    this.unconfirmedUser = [];
    this.streaming.clear();
    this.openTools.clear();
    this.dirty.clear();
    this.lastSeq = null;
    this.counter = 0;
    this.structural = true;
    this.markPending();
  }

  /**
   * Fold one normalized event into the transcript.
   *
   * Ordering assumptions come straight from the protocol: `session.started`
   * first, `run.end` last and always present, every `tool.start` eventually
   * paired with a `tool.end`. Where an assumption is violated the model
   * degrades rather than throwing — a UI that crashes on a malformed event
   * stream is worse than one that shows an orphaned card.
   */
  apply(event: AgentEvent): void {
    this.checkSequence(event.seq);

    switch (event.type) {
      case 'session.started': {
        const detail = [
          event.model ? `model ${event.model}` : null,
          event.permissionMode ? `mode ${event.permissionMode}` : null,
          event.resumedFrom ? `${event.forked ? 'forked from' : 'resumed'} ${event.resumedFrom}` : null,
          event.providerVersion ? `${event.providerId} ${event.providerVersion}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');
        this.note('info', `Session ${short(event.sessionId)} started in ${event.cwd}`, detail);
        break;
      }

      case 'text.delta': {
        const id = this.blockId('a', event.messageId, event.blockIndex);
        if (!this.items.has(id)) {
          this.insert({
            id,
            ts: event.ts,
            kind: 'assistant',
            messageId: event.messageId,
            blockIndex: event.blockIndex,
            text: '',
            streaming: true,
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          });
          this.trackBlock(event.messageId, id);
        }
        this.append(id, event.text);
        break;
      }

      case 'text.complete': {
        if (event.role === 'user') {
          this.completeUserText(event.text, event.replay === true, event.synthetic === true, event.ts);
          break;
        }
        const id = this.resolveAssistantBlock(event.messageId, event.blockIndex);
        const existing = this.items.get(id);
        const base: AssistantItem = {
          id,
          ts: existing?.ts ?? event.ts,
          kind: 'assistant',
          messageId: event.messageId,
          blockIndex: event.blockIndex ?? (existing?.kind === 'assistant' ? existing.blockIndex : 0),
          text: event.text,
          streaming: false,
          ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
          ...(event.replay === undefined ? {} : { replay: event.replay }),
          ...(event.synthetic === undefined ? {} : { synthetic: event.synthetic }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        };
        // `text.complete` carries the whole block, so it wins over the buffer.
        this.buffers.set(id, event.text);
        if (existing) this.replace(id, base);
        else {
          this.insert(base);
          this.trackBlock(event.messageId, id);
        }
        break;
      }

      case 'thinking.delta': {
        const id = this.blockId('k', event.messageId, event.blockIndex);
        if (!this.items.has(id)) {
          this.insert({
            id,
            ts: event.ts,
            kind: 'thinking',
            messageId: event.messageId,
            blockIndex: event.blockIndex,
            text: '',
            streaming: true,
            redacted: event.redacted === true,
            ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          });
        }
        this.append(id, event.text);
        break;
      }

      case 'tool.start': {
        const id = `t:${event.toolCallId}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'tool',
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
          status: 'running',
          ...(event.title === undefined ? {} : { title: event.title }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: event.parentToolCallId }),
        });
        // A new tool call ends the assistant block that issued it.
        this.settleStreaming();
        break;
      }

      case 'tool.end': {
        const id = `t:${event.toolCallId}`;
        const existing = this.items.get(id);
        const merged: ToolItem = {
          id,
          ts: existing?.ts ?? event.ts,
          kind: 'tool',
          toolCallId: event.toolCallId,
          name: existing?.kind === 'tool' ? existing.name : (event.name ?? 'tool'),
          input: existing?.kind === 'tool' ? existing.input : {},
          status: event.status,
          ...(existing?.kind === 'tool' && existing.title !== undefined
            ? { title: existing.title }
            : {}),
          ...(event.result === undefined ? {} : { result: event.result }),
          ...(event.resultText === undefined ? {} : { resultText: event.resultText }),
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
          ...(event.parentToolCallId === undefined
            ? {}
            : { parentToolCallId: event.parentToolCallId }),
        };
        if (existing) this.replace(id, merged);
        else this.insert(merged);
        break;
      }

      case 'permission.request': {
        const id = `p:${event.requestId}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'permission',
          requestId: event.requestId,
          request: event.request,
          state: 'pending',
        });
        this.settleStreaming();
        break;
      }

      case 'usage':
        // Usage is a run-level readout, not a transcript entry; the app store
        // keeps it and the detail panel renders it live.
        break;

      case 'run.end': {
        this.settleStreaming();
        this.failOpenToolCalls(event.reason);
        const id = `e:${++this.counter}`;
        this.insert({
          id,
          ts: event.ts,
          kind: 'run-end',
          reason: event.reason,
          ...(event.error === undefined ? {} : { error: event.error }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
          ...(event.numTurns === undefined ? {} : { numTurns: event.numTurns }),
          ...(event.result === undefined ? {} : { result: event.result }),
        });
        this.lastSeq = null;
        break;
      }

      default: {
        // Exhaustiveness without a throw: a provider that learns a new event
        // type should not be able to take the window down.
        const unhandled: never = event;
        void unhandled;
        break;
      }
    }

    this.markPending();
  }

  /** Apply every coalesced change and notify. Public for tests. */
  flush(): void {
    this.pending = false;
    const changed = this.dirty;
    if (changed.size > 0) {
      this.dirty = new Set();
      for (const id of changed) {
        const item = this.items.get(id);
        if (!item) continue;
        const buffered = this.buffers.get(id);
        if (buffered !== undefined && (item.kind === 'assistant' || item.kind === 'thinking')) {
          if (item.text !== buffered) this.items.set(id, { ...item, text: buffered });
        }
        const listeners = this.itemListeners.get(id);
        if (listeners) for (const listener of listeners) listener();
      }
    }

    // Membership before summaries: a structural change can move a tool into a
    // different group, and recomputing the old group's counts first would
    // notify a group that is about to stop existing.
    const restructured = this.structural;
    if (restructured) {
      this.structural = false;
      this.idsSnapshot = this.ids.length === 0 ? EMPTY_IDS : this.ids.slice();
      this.rebuildRows();
      for (const listener of this.listListeners) listener();
    }

    this.refreshGroups(changed, restructured);
  }

  /* ---- internals ------------------------------------------------------ */

  private insert(item: TranscriptItem): void {
    if (this.items.has(item.id)) {
      this.replace(item.id, item);
      return;
    }
    this.items.set(item.id, item);
    this.ids.push(item.id);
    if (item.kind === 'assistant' || item.kind === 'thinking') this.buffers.set(item.id, item.text);
    this.index(item);
    this.structural = true;
    this.dirty.add(item.id);
    this.markPending();
  }

  private replace(id: string, item: TranscriptItem): void {
    this.items.set(id, item);
    this.index(item);
    this.dirty.add(id);
    this.markPending();
  }

  /**
   * Recompute the row sequence, folding runs of machinery into groups.
   *
   * O(items), and called only where the `ids` snapshot is already being copied
   * — so this rides along with work the model was doing anyway rather than
   * adding a pass of its own. See {@link ActivityGroup} for why it cannot live
   * in the component, and why a run is thinking-and-tools rather than tools.
   *
   * A group is named for its first member, which makes the id stable as the
   * run grows: appending to an open burst extends the group rather than
   * renaming it, so an expanded marker does not collapse itself every time the
   * agent runs one more command.
   *
   * The one place a row id does change under the reader is the moment a run of
   * pure thinking gains its first tool call — a thinking row becomes a marker.
   * That is the fold arriving, not a glitch: the alternative is holding the
   * burst back until it is over, which would mean the transcript showed nothing
   * at all while the work was happening.
   */
  private rebuildRows(): void {
    const rows: string[] = [];
    const members = new Map<string, readonly string[]>();
    const groupOf = new Map<string, string>();

    for (let i = 0; i < this.ids.length; ) {
      const id = this.ids[i];
      if (id === undefined) {
        i += 1;
        continue;
      }
      if (!this.isMachinery(id)) {
        rows.push(id);
        i += 1;
        continue;
      }
      const run: string[] = [];
      let tools = 0;
      while (i < this.ids.length) {
        const next = this.ids[i];
        if (next === undefined || !this.isMachinery(next)) break;
        if (this.items.get(next)?.kind === 'tool') tools += 1;
        run.push(next);
        i += 1;
      }
      // Nothing was *done* here, so there is nothing to summarise: a stretch of
      // thinking on its own stays the rows it already was.
      if (tools === 0) {
        for (const memberId of run) rows.push(memberId);
        continue;
      }
      const groupId = `g:${id}`;
      for (const memberId of run) groupOf.set(memberId, groupId);
      members.set(groupId, run);
      rows.push(groupId);
    }

    // Retire cached summaries whose group is gone or whose membership moved.
    // Everything else keeps its object identity, which is the point.
    for (const [groupId, snapshot] of this.groupSnapshots) {
      const next = members.get(groupId);
      if (next === undefined || !sameIds(next, snapshot.ids)) this.groupSnapshots.delete(groupId);
    }

    this.groupMembers = members;
    this.groupOf = groupOf;
    this.rowsSnapshot = rows.length === 0 ? EMPTY_IDS : rows.slice();
  }

  /**
   * Rebuild the summaries that could have changed, and notify only those.
   *
   * The comparison matters more than it looks, and more than it used to. A
   * `tool.end` marks one item dirty, and without the equality check every
   * marker on screen would be notified on every flush that touched any tool —
   * but a *thinking* member is dirty on every frame it streams, so this is now
   * what keeps a group silent while one of its blocks is being written. It can
   * be: the summary holds counters, never text, so the rebuilt snapshot
   * compares equal until something actually happens.
   */
  private refreshGroups(changed: ReadonlySet<string>, restructured: boolean): void {
    const touched = new Set<string>();
    if (restructured) for (const groupId of this.groupMembers.keys()) touched.add(groupId);
    for (const id of changed) {
      const groupId = this.groupOf.get(id);
      if (groupId !== undefined) touched.add(groupId);
    }
    if (touched.size === 0) return;

    for (const groupId of touched) {
      const next = this.buildGroup(groupId);
      if (!next) {
        this.groupSnapshots.delete(groupId);
        continue;
      }
      const previous = this.groupSnapshots.get(groupId);
      if (previous && sameGroup(previous, next)) continue;
      this.groupSnapshots.set(groupId, next);
      const listeners = this.groupListeners.get(groupId);
      if (listeners) for (const listener of listeners) listener();
    }
  }

  /** Count one group's members by category. O(members), not O(items). */
  private buildGroup(id: string): ActivityGroup | undefined {
    const ids = this.groupMembers.get(id);
    if (ids === undefined || ids.length === 0) return undefined;

    const counts: Partial<Record<ToolCategory, number>> = {};
    let thinking = 0;
    let running = 0;
    let failed = 0;
    let streaming = false;
    let ts: number | undefined;

    for (const memberId of ids) {
      const item = this.items.get(memberId);
      if (item?.kind === 'thinking') {
        ts ??= item.ts;
        thinking += 1;
        if (item.streaming) streaming = true;
        continue;
      }
      if (item?.kind !== 'tool') continue;
      ts ??= item.ts;
      const category = classifyTool(item.name);
      counts[category] = (counts[category] ?? 0) + 1;
      if (item.status === 'running') running += 1;
      else if (item.status === 'error' || item.status === 'denied') failed += 1;
    }

    return { id, ids, ts: ts ?? 0, counts, thinking, running, failed, streaming };
  }

  /** Whether a row is machinery — the thing runs are made of. */
  private isMachinery(id: string): boolean {
    const kind = this.items.get(id)?.kind;
    return kind === 'tool' || kind === 'thinking';
  }

  /** Keep the open-work indexes in step with an item's current state. */
  private index(item: TranscriptItem): void {
    if (item.kind === 'assistant' || item.kind === 'thinking') {
      if (item.streaming) this.streaming.add(item.id);
      else this.streaming.delete(item.id);
    } else if (item.kind === 'tool') {
      if (item.status === 'running') this.openTools.add(item.id);
      else this.openTools.delete(item.id);
    }
  }

  private append(id: string, chunk: string): void {
    if (chunk.length === 0) return;
    this.buffers.set(id, (this.buffers.get(id) ?? '') + chunk);
    this.dirty.add(id);
  }

  private markPending(): void {
    if (this.pending) return;
    this.pending = true;
    this.schedule(() => this.flush());
  }

  private blockId(prefix: 'a' | 'k', messageId: string, blockIndex: number): string {
    return `${prefix}:${messageId}:${blockIndex}`;
  }

  private trackBlock(messageId: string, id: string): void {
    const blocks = this.messageBlocks.get(messageId);
    if (blocks) blocks.push(id);
    else this.messageBlocks.set(messageId, [id]);
  }

  /**
   * Find the item a `text.complete` belongs to.
   *
   * With a `blockIndex` it is a direct hit. Without one — providers that do
   * not stream never send an index — it attaches to the last still-streaming
   * block of that message, or starts a new one.
   */
  private resolveAssistantBlock(messageId: string, blockIndex: number | undefined): string {
    if (blockIndex !== undefined) return this.blockId('a', messageId, blockIndex);
    const blocks = this.messageBlocks.get(messageId) ?? [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const candidate = blocks[i];
      if (candidate === undefined) continue;
      const item = this.items.get(candidate);
      if (item?.kind === 'assistant' && item.streaming) return candidate;
    }
    return this.blockId('a', messageId, blocks.length);
  }

  /**
   * Reconcile a provider-echoed user message with the optimistic one already
   * on screen, so the user's own prompt does not appear twice.
   */
  private completeUserText(text: string, replay: boolean, synthetic: boolean, ts: number): void {
    if (!replay && !synthetic) {
      const pendingId = this.unconfirmedUser.shift();
      if (pendingId !== undefined) {
        const existing = this.items.get(pendingId);
        if (existing?.kind === 'user') {
          this.replace(pendingId, { ...existing, text, pending: false });
          return;
        }
      }
    }
    const id = `u:${++this.counter}`;
    this.insert({ id, ts, kind: 'user', text, pending: false });
  }

  /** Mark every streaming block finished. Called when the turn moves on. */
  private settleStreaming(): void {
    if (this.streaming.size === 0) return;
    for (const id of this.streaming) {
      const item = this.items.get(id);
      if (item?.kind === 'assistant' || item?.kind === 'thinking') {
        this.replace(id, { ...item, text: this.buffers.get(id) ?? item.text, streaming: false });
      }
    }
    this.streaming.clear();
  }

  /**
   * Close out tool calls the provider left open.
   *
   * The protocol says every `tool.start` gets a `tool.end`, including on
   * interrupt — but the UI must never be left with a spinner it cannot clear,
   * so a run that ends with calls still running gets them closed here.
   */
  private failOpenToolCalls(reason: RunEndReason): void {
    if (this.openTools.size === 0) return;
    const status: ToolStatus = reason === 'error' ? 'error' : 'cancelled';
    for (const id of this.openTools) {
      const item = this.items.get(id);
      if (item?.kind === 'tool' && item.status === 'running') this.replace(id, { ...item, status });
    }
    this.openTools.clear();
  }

  /** `seq` is dense per run; a gap means the transport dropped something. */
  private checkSequence(seq: number): void {
    if (this.lastSeq !== null && seq > this.lastSeq + 1) {
      const missing = seq - this.lastSeq - 1;
      this.note('warn', `${missing} event${missing === 1 ? '' : 's'} were dropped in transit`);
    }
    if (this.lastSeq === null || seq > this.lastSeq) this.lastSeq = seq;
  }
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether two summaries say the same thing.
 *
 * Field-by-field rather than a `JSON.stringify` compare: this runs on every
 * flush that touches a tool, and serialising both sides to decide "nothing
 * changed" would allocate two strings per group per tool call.
 */
function sameGroup(a: ActivityGroup, b: ActivityGroup): boolean {
  if (a.ts !== b.ts || a.running !== b.running || a.failed !== b.failed) return false;
  if (a.thinking !== b.thinking || a.streaming !== b.streaming) return false;
  if (!sameIds(a.ids, b.ids)) return false;
  const keys = Object.keys(a.counts) as ToolCategory[];
  if (keys.length !== Object.keys(b.counts).length) return false;
  for (const key of keys) if (a.counts[key] !== b.counts[key]) return false;
  return true;
}
