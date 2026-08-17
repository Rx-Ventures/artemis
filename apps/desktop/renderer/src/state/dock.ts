/**
 * The dock: things a conversation put on screen beside itself.
 * ============================================================================
 *
 *     ╭──────────────────────╮╭───────────────────────────╮
 *     │ artemis › Wire seam  ││ ◱ sales.html ✕   ▸ zsh ✕ +│  ← the tab strip
 *     ├──────────────────────┤├───────────────────────────┤
 *     │  TRANSCRIPT          ││                           │
 *     │  COMPOSER · STATUS   ││   ~/libra ❯ pnpm dev      │
 *     ╰──────────────────────╯╰───────────────────────────╯
 *
 * Several kinds of thing live in the right-hand rail: a **preview**, which is a
 * file the agent wrote; a **terminal**, which is a shell the user asked for; and
 * a **browser**, which is a page. They have almost nothing in common as objects
 * — one is a snapshot of some bytes, one is a running process, one is a native
 * view the main process draws — and exactly one thing in common as *UI*: each
 * belongs to a conversation, and none makes any sense next to a different one.
 * This module is that one thing, factored out.
 *
 * ## Ownership, and why it needs two ids
 *
 * A {@link DockOwner} names a conversation the way `PreviewOwner` always has:
 * by pane, by run, and by session, because no one of them covers a
 * conversation's whole life.
 *
 * A run has no `sessionId` until `session.started` arrives — which is precisely
 * the window in which a fresh conversation writes its first artifact or gets its
 * first terminal — so the run id identifies it until the session id exists. Once
 * it does, {@link learnSessionId} adopts it, and from then on ownership survives
 * the run ending, a later resume, and a fork. Before either exists, a brand new
 * pane that has never run anything is identified by the pane alone, which is
 * what makes "open a terminal in an empty session" work at all.
 *
 * ## Where the two kinds part company
 *
 * When a conversation leaves the screen:
 *
 *  - **its preview is destroyed.** It was a snapshot; reopening it is one click
 *    on the tile that is still in the transcript.
 *  - **its terminal is only hidden.** The shell keeps running.
 *  - **its browser is only hidden**, on the terminal's side of the line and for
 *    the terminal's reason.
 *
 * That asymmetry is the single most important decision in this feature, so it is
 * worth stating why rather than leaving it to be discovered. A preview costs
 * nothing to recreate and holds no state anyone would miss. A terminal is the
 * opposite on both counts: it is very often a `pnpm dev`, a `tail -f`, or an
 * ssh session, and killing one because the user clicked another conversation in
 * the sidebar would make the feature actively dangerous to use. So the tab
 * disappears with its conversation, comes back with it, and only the ✕ ends the
 * process — which is exactly what a tab's ✕ means everywhere else.
 *
 * A browser sorts with the terminal because the test is "could this be rebuilt
 * from what is still on screen", and a page cannot: it has a scroll position, a
 * session cookie, and quite possibly a half-filled form. Reloading it is not
 * reopening it.
 *
 * ## Everything here is pure
 *
 * No store, no `Pane`, no bridge. The functions take a description of what the
 * columns are currently showing ({@link ShownConversation}) and answer questions
 * about it. That is what lets the reconciliation rules — the part with all the
 * edge cases — be tested without building a window.
 */

import type {
  BrowserId,
  BrowserInfo,
  RunId,
  SessionId,
  TerminalId,
  TerminalInfo,
} from '@rx-artemis/protocol';
import type { PaneId } from './pane';

/**
 * Which tab the dock is showing.
 *
 * A discriminated union rather than a string, because a terminal's identity is
 * its {@link TerminalId} and flattening that into `"terminal:abc"` would mean
 * parsing it back out at every use. {@link tabKey} exists for the two places
 * that genuinely need a string — a React `key` and a `Set` — and nowhere else.
 */
export type DockTab =
  | { readonly kind: 'preview' }
  /**
   * A file the conversation named, shown as text.
   *
   * Keyed by nothing, exactly like {@link PREVIEW_TAB} and for the same three
   * reasons: it is a snapshot rather than a process, reopening it is one click
   * on the link that is still in the transcript, and one at a time is what keeps
   * the affordance safe to put on *every* path in an answer. A tab per file
   * would let a reader skimming one paragraph fill the strip with eight of them.
   *
   * The consequence to be aware of is that following a second link replaces the
   * first, so two files cannot be read side by side. That is the same limitation
   * the preview has always had, it is the reason the link stays live in the
   * transcript, and it is the thing to revisit first if this surface grows.
   */
  | { readonly kind: 'file' }
  | { readonly kind: 'terminal'; readonly id: TerminalId }
  /**
   * A page the user opened, drawn by the main process behind this pane.
   *
   * Keyed by id and owned exactly like a terminal, because it is the same kind
   * of object: a *live* thing with state nobody can reconstruct. A page has a
   * scroll position, a session cookie and possibly a half-filled form, so it is
   * hidden when its conversation leaves the screen and destroyed only by the ✕.
   * The preview and file tabs go the other way for the opposite reason — they
   * are snapshots, and the link that made one is still in the transcript.
   */
  | { readonly kind: 'browser'; readonly id: BrowserId }
  /**
   * What one conversation has delegated. One tab, however many tasks — the list
   * is the pane's content, not the strip's.
   *
   * Keyed by pane rather than being a constant beside {@link PREVIEW_TAB},
   * because unlike a preview there can be two of these on screen at once: a
   * split with an agent working in each column has two sets of delegated work,
   * and they are not the same list. The pane is the right key rather than the
   * run — the rows outlive the run that launched them, which is the entire
   * subject — and rather than the session, which does not exist yet for a
   * conversation whose first turn is the one delegating.
   */
  | { readonly kind: 'tasks'; readonly paneId: PaneId }
  /**
   * One delegated agent's own conversation, opened from a row in the tasks tab.
   *
   * The list answers "what is running"; this answers "what is it *doing*", and
   * nothing else can. A subagent writes its own transcript beside its parent's
   * and the parent keeps only the final report — so the work itself, the tool
   * calls and the reasoning, exists on disk in a file the delegating session
   * never shows. Without this the only view of an agent is a one-line summary.
   *
   * Keyed by pane *and* task, for the reason the tasks tab is keyed by pane:
   * two columns can each have delegated work, and their agents are not the same
   * agents. The task id is the provider's own, which is also the id its
   * transcript is filed under — see `openAgentTab`.
   */
  | { readonly kind: 'agent'; readonly paneId: PaneId; readonly taskId: string };

/** The preview tab. A constant, because there is only ever one. */
export const PREVIEW_TAB: DockTab = { kind: 'preview' };

/** The file tab. A constant, for {@link PREVIEW_TAB}'s reason. */
export const FILE_TAB: DockTab = { kind: 'file' };

/** A stable string for one tab. For React keys and set membership only. */
export function tabKey(tab: DockTab): string {
  switch (tab.kind) {
    case 'preview':
      return 'preview';
    case 'file':
      return 'file';
    case 'terminal':
      return `terminal:${tab.id}`;
    case 'browser':
      return `browser:${tab.id}`;
    case 'tasks':
      return `tasks:${tab.paneId}`;
    default:
      return `agent:${tab.paneId}:${tab.taskId}`;
  }
}

/** Whether two tabs are the same tab. */
export function sameTab(a: DockTab | null, b: DockTab | null): boolean {
  if (a === null || b === null) return a === b;
  return tabKey(a) === tabKey(b);
}

/**
 * Which conversation something in the dock belongs to.
 *
 * See the file header for why all three fields exist and why two of them are
 * optional. An owner with neither `runId` nor `sessionId` is a pane that has
 * never run anything — legitimate, and identified by `paneId` alone.
 */
export interface DockOwner {
  readonly paneId: PaneId;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
}

/**
 * What one column is showing right now.
 *
 * The projection of a `Pane` that this module needs, and nothing more. Built by
 * the store from the visible panes; see `describeShown` there.
 */
export interface ShownConversation {
  readonly paneId: PaneId;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
  /**
   * Whether this column has delegated work it is still offering a tab for.
   *
   * Not simply "has any": a column whose rows have all been dismissed by the
   * tab's ✕ answers no until something new is delegated. The store decides that
   * — see `showsTasks` — because it is a question about rows, and carrying the
   * rows through here would make every progress message rebuild the strip.
   */
  readonly hasTasks?: boolean;
}

/**
 * One browser, as the window holds it.
 *
 * `title` follows the page rather than the address for the reason a terminal's
 * follows the running program: a strip of tabs all saying `https` would be
 * useless the moment there were two of them. It is page-authored text, so it is
 * capped by main and rendered as text.
 */
export interface BrowserRecord {
  readonly info: BrowserInfo;
  readonly owner: DockOwner;
  /**
   * True for a page an agent opened with a tool, absent for one the user asked
   * for. The record is kept either way — main is driving the page and it must
   * stay closeable and re-ownable — but `visibleTabs` only surfaces an
   * agent-opened page while the dock is allowed to open on its own. Marked on
   * the record rather than resolved at arrival so that turning the setting on
   * later reveals the pages that arrived while it was off.
   */
  readonly agentOpened?: boolean;
}

/**
 * One terminal, as the window holds it.
 *
 * `title` is separate from `info.shell` because it follows the running program:
 * a shell that starts as `zsh` becomes `vim` and then `zsh` again, reported by
 * the OSC title sequence xterm already parses. A tab that always said `zsh`
 * would be useless the moment there were two of them.
 */
export interface TerminalRecord {
  readonly info: TerminalInfo;
  readonly owner: DockOwner;
  readonly title: string;
  /** True once the shell has exited. The tab stays until the user closes it. */
  readonly exited: boolean;
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is the conversation this belongs to on screen?
 *
 * Three cases, in the order they are decided:
 *
 *  1. **A session id settles it outright.** That is the durable identity — it
 *     survives the run ending and matches a later resume of the same
 *     conversation, in whichever column it was resumed into. A terminal follows
 *     its conversation across the grid, which is the behaviour people expect
 *     from something they think of as "this project's shell".
 *  2. **A run id, in the column it started in.** Before `session.started` there
 *     is nothing durable to match on, so identity is the run — and a pane whose
 *     run has since been replaced is showing a different conversation even
 *     though it is the same column.
 *  3. **Neither: the pane itself.** A conversation that has never run anything.
 */
export function ownerIsShown(owner: DockOwner, shown: readonly ShownConversation[]): boolean {
  if (owner.sessionId !== undefined) {
    return shown.some((one) => one.sessionId === owner.sessionId);
  }
  if (owner.runId !== undefined) {
    return shown.some((one) => one.paneId === owner.paneId && one.runId === owner.runId);
  }
  // Case 3, and note that it does **not** compare runs. A terminal opened on an
  // empty session belongs to the column, and stays there as the column is used:
  // sending the first prompt starts a run, and a check that required the pane's
  // run to still match `undefined` would make the tab vanish at exactly that
  // moment — the shell disappearing the first time you talk to the agent.
  return shown.some((one) => one.paneId === owner.paneId);
}

/**
 * The session id this owner's conversation has learned since, if any.
 *
 * Returns `null` when there is nothing to adopt — which is the overwhelmingly
 * common case, since an owner adopts at most once and most of them arrive with a
 * session id already.
 *
 * Two guards, and both are about adopting the *wrong* id rather than about
 * tidiness:
 *
 *  - **There has to be a run to learn from.** Adoption models one specific
 *    event: a run that had no session id being told what it is. An owner with no
 *    run is not waiting to find out — it is a terminal opened on an empty
 *    column, and letting it adopt would mean the first session resumed into that
 *    column quietly claiming it, so closing that session would take an unrelated
 *    shell with it.
 *  - **The run has to still be the same one.** A pane that has moved on is a
 *    different conversation, and taking its session id would re-home the tab
 *    onto work this owner has nothing to do with.
 */
export function learnSessionId(
  owner: DockOwner,
  shown: readonly ShownConversation[],
): SessionId | null {
  if (owner.sessionId !== undefined || owner.runId === undefined) return null;
  const home = shown.find((one) => one.paneId === owner.paneId);
  if (home === undefined || home.runId !== owner.runId) return null;
  return home.sessionId ?? null;
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The tabs to draw, left to right.
 *
 * Preview first, terminals after in the order they were opened, tasks last.
 * Fixed rather than most-recent-first, because a strip that reorders itself
 * moves the ✕ the user was aiming at — the same reason `sessionOrderHold` exists
 * for the sidebar.
 *
 * Tasks pin to the end for a sharper version of that argument. It is the one tab
 * nobody opens: the agent delegates something and it appears, mid-turn, without
 * anyone reaching for it. Anywhere but the end, that arrival would shift every
 * tab to its right out from under a pointer already on the way to one.
 *
 * It appears with the first task and stays while any row remains — settled rows
 * included, since the moment work finishes is when its result is worth reading.
 * Its ✕ dismisses the tab and nothing else: the rows are still there, the
 * subagents are still running, and the next thing delegated brings it back. See
 * `closeTasks` in the store for why that is a weaker ✕ than the two beside it,
 * and `hasTasks` for where a dismissed column stops answering yes.
 */
export function visibleTabs(
  previewOwner: DockOwner | null,
  terminals: readonly TerminalRecord[],
  shown: readonly ShownConversation[],
  /**
   * Agent transcripts the user has opened, in the order they opened them.
   *
   * Passed as (pane, task) pairs rather than as whole views, for the reason
   * `hasTasks` is a boolean: this module decides which tabs exist, and carrying
   * a transcript model through it would rebuild the strip on every message the
   * agent produced.
   */
  agents: readonly { readonly paneId: PaneId; readonly taskId: string }[] = [],
  /**
   * Whose file view is open, if one is. Follows the preview's rules exactly —
   * it is drawn while its conversation is on screen and destroyed when that
   * conversation leaves, because it is a snapshot and the link is the way back.
   */
  fileOwner: DockOwner | null = null,
  /**
   * Pages this window has open, in the order they were opened.
   *
   * Ordered and placed exactly like {@link terminals}, and for the reason the
   * strip never reorders itself: a browser and a shell are both things the user
   * asked for, and interleaving them by recency would move the ✕ somebody was
   * aiming at.
   */
  browsers: readonly BrowserRecord[] = [],
  /**
   * Whether surfaces the *agent* put here may claim a tab.
   *
   * False is the appearance option "the dock never opens on its own": the
   * tasks tab (the one tab nobody opens — it arrives with delegated work) and
   * agent-opened pages stay out of the strip entirely, because any tab in an
   * empty strip is what opens the dock. Everything the user opened — preview,
   * file, shells, their own pages, agent transcripts they clicked into — is
   * user input and stays. The suppressed records still exist; flipping the
   * setting back on reveals them on the next reconcile.
   */
  agentSurfaces: boolean = true,
): readonly DockTab[] {
  const tabs: DockTab[] = [];
  if (previewOwner !== null && ownerIsShown(previewOwner, shown)) tabs.push(PREVIEW_TAB);
  // Beside the preview rather than at the end: both are "a file this
  // conversation put on screen", and the two arriving in different places would
  // make the strip's order look arbitrary.
  if (fileOwner !== null && ownerIsShown(fileOwner, shown)) tabs.push(FILE_TAB);
  for (const terminal of terminals) {
    if (ownerIsShown(terminal.owner, shown)) tabs.push({ kind: 'terminal', id: terminal.info.id });
  }
  // After the shells rather than before them, which is only a convention — but
  // a fixed one, so that opening a browser never shifts a terminal's ✕.
  for (const browser of browsers) {
    if (browser.agentOpened === true && !agentSurfaces) continue;
    if (ownerIsShown(browser.owner, shown)) tabs.push({ kind: 'browser', id: browser.info.id });
  }
  for (const one of shown) {
    if (one.hasTasks === true && agentSurfaces) tabs.push({ kind: 'tasks', paneId: one.paneId });
    // A column's open agents sit directly after its own list, so the thing a
    // tab was opened *from* stays beside it rather than at the far end of a
    // split's strip.
    for (const agent of agents) {
      if (agent.paneId === one.paneId) tabs.push({ kind: 'agent', ...agent });
    }
  }
  return tabs;
}

/**
 * Which tab should be active, given what is visible.
 *
 * Keeps the current one when it is still there. Otherwise falls to the
 * **neighbour on the left**, or the first tab when there is none — the same rule
 * `closePane` uses for focus, and the same one a browser uses when you close a
 * tab: the eye is already near where the closed tab was, and jumping to the far
 * end of the strip is disorienting.
 *
 * `previous` is the strip as it was *before* whatever changed, which is what
 * makes "the neighbour on the left" answerable at all — after the fact, the
 * closed tab's position is gone.
 */
export function nextActiveTab(
  active: DockTab | null,
  visible: readonly DockTab[],
  previous: readonly DockTab[] = visible,
): DockTab | null {
  if (visible.length === 0) return null;
  if (active !== null && visible.some((tab) => sameTab(tab, active))) return active;

  const wasAt = active === null ? -1 : previous.findIndex((tab) => sameTab(tab, active));
  if (wasAt > 0) {
    // Walk left from where it was until something that survived turns up.
    for (let i = wasAt - 1; i >= 0; i -= 1) {
      const candidate = previous[i] as DockTab;
      if (visible.some((tab) => sameTab(tab, candidate))) return candidate;
    }
  }
  return visible[0] as DockTab;
}
