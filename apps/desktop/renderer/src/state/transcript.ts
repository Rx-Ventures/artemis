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
  JsonObject,
  JsonValue,
  PermissionRequest,
  RunEndReason,
  StopReason,
  ToolEndStatus,
  UsageSnapshot,
} from '@libra/protocol';

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

  /** Stable snapshot of one item. New identity only when that item changed. */
  getItem = (id: string): TranscriptItem | undefined => this.items.get(id);

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

  /* ---- writes --------------------------------------------------------- */

  /** Add the user's message optimistically, before the round-trip returns. */
  pushUserMessage(text: string): string {
    const id = `u:${++this.counter}`;
    this.insert({ id, ts: Date.now(), kind: 'user', text, pending: true });
    this.unconfirmedUser.push(id);
    return id;
  }

  /**
   * Mark an optimistic user message as delivered.
   *
   * {@link pushUserMessage} renders the prompt before the round-trip returns
   * and flags it `pending`, which the UI draws dimmed. Something has to clear
   * that flag, and the provider echo cannot: the Claude mapper deliberately
   * drops the echo of Libra's own prompt (the renderer already drew it), so
   * `completeUserText`'s reconciliation branch never runs for a live turn and
   * every message the user ever sent would stay dimmed for the life of the
   * window, with its id accumulating in `unconfirmedUser` forever.
   *
   * So confirmation happens at the point Libra actually knows the text was
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

    if (this.structural) {
      this.structural = false;
      this.idsSnapshot = this.ids.length === 0 ? EMPTY_IDS : this.ids.slice();
      for (const listener of this.listListeners) listener();
    }

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
