/**
 * Application state.
 *
 * Everything that is *not* the streaming transcript lives here: profiles,
 * providers, the live run's metadata, the permission queue, the error surface.
 * The transcript itself is deliberately outside this store — see
 * `transcript.ts` for why — and the two are joined in `handleAgentEvent`.
 *
 * Actions are plain exported functions rather than store methods. They read
 * through `useApp.getState()` and write through `useApp.setState()`, which
 * keeps the store's type trivial and means a component can call an action
 * without subscribing to anything.
 *
 * ## This store is the *window*. The conversation lives in a pane.
 *
 * Split view is the reason there are two stores. Everything that answers "what
 * will the next prompt in this column do" — the directory, the profile, the
 * model, the live run, the parked permissions, the transcript — moved into
 * `pane.ts`, one copy per open column. What is left here is genuinely about the
 * application: the session list, the catalogues, the sidebar, the banners, the
 * palette, the settings surface.
 *
 * Two consequences for anyone adding to this file:
 *
 *  - **A session-scoped action takes a `Pane`.** By convention it is the last
 *    parameter and defaults to {@link focusedPane}, so window-level surfaces
 *    (the palette, settings, a hotkey) can call it unchanged and a control
 *    inside a column passes its own.
 *  - **A selector over session state takes `SessionState`, not `AppState`.**
 *    Five window values are mirrored into every pane so those selectors stay
 *    single-argument; `pane.ts` explains why, and {@link mirrorToPanes} is the
 *    only writer.
 */

import { create } from 'zustand';
import {
  ARCHIVED_TAG,
  isArchived,
  isEndedRunError,
  isProfileAutoSelectable,
  isProfileEnabled,
  isSameModel,
  NO_CAPABILITIES,
  recommendProfile,
  resolvePlanWeight,
} from '@rx-artemis/protocol';
import type {
  ArtemisBridge,
  AuthStatusInfo,
  AgentError,
  AgentEvent,
  AllowPermissionDecision,
  Attachment,
  Capabilities,
  IpcError,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionScope,
  PlanRecommendation,
  LiveRunLoad,
  PlanUsage,
  PreviewOpenResponse,
  FilesReadResponse,
  ProfileDraft,
  ProfileId,
  ProfileMetadata,
  ProfilePatch,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderId,
  ProviderModelOption,
  RunEndReason,
  RunHandle,
  RunId,
  RunInput,
  RunStatus,
  SessionDelegatedWork,
  SessionId,
  SessionSummary,
  TerminalId,
  TokenUsage,
  HandoffTrigger,
  UpdateChannel,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import { activityOf } from '../components/Activity';
import {
  handoffPrompt,
  handoffReason,
  handoffStamp,
  setHandoff,
  HANDOFF_BLOCK_DETAIL,
} from './autoHandoff';
import { call, resolveBridge, type BridgeMode } from '../lib/bridge';
import {
  describeWorkspace,
  listSessionsEverywhere,
  pickDirectory,
  type DirectoryChoice,
  type SessionScope,
  type WorkspaceNames,
} from '../lib/extensions';
import { detectArtifact, type Artifact } from '../lib/artifact';
import { detectFileEdit } from '../lib/diff';
import { isAbsolutePath, lastSegment } from '../lib/paths';
import { newId } from '../lib/id';
import { entriesFiling, sessionKey } from '../lib/sessionGroups';
import {
  disposeTerminalSession,
  ensureTerminalSession,
  noteTerminalExit,
  requestTerminalFocus,
  retheme,
  setTerminalSessionHooks,
  writeToTerminal,
} from '../lib/terminalSessions';
import {
  EMPTY_DOCK_LAYOUT,
  MAX_RESTORED_BROWSERS,
  MAX_RESTORED_TERMINALS,
  parseDockLayout,
  type DockLayout,
  learnSessionId,
  nextActiveTab,
  ownerIsShown,
  PREVIEW_TAB,
  sameTab,
  visibleTabs,
  type DockOwner,
  type DockTab,
  type ShownConversation,
  type TerminalRecord,
  type BrowserRecord,
} from './dock';
import { resolveFilePath, type FileReference } from '../lib/filePaths';
import {
  isTaskLive,
  type BackgroundTask,
  type BrowserBounds,
  type BrowserCommand,
  type BrowserId,
} from '@rx-artemis/protocol';
import { setEventsDroppedHook, type PermissionItem, type TranscriptModel } from './transcript';
import {
  MIRRORED_KEYS,
  UNSTARTED_DRAFT,
  createPane,
  createRow,
  paneState,
  setHostPlatform,
  setPaneState,
  type MirroredState,
  type Pane,
  type PaneId,
  type PaneRow,
  type RunState,
  type SessionState,
} from './pane';

export type { Pane, PaneId, PaneRow, RunState, SessionState };

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type Screen = 'chat' | 'profiles';

/**
 * Which pane of the settings surface is showing.
 *
 * Deliberately *not* folded into {@link Screen}. `screen` stays
 * `'chat' | 'profiles'` — where `'profiles'` has come to mean "settings is
 * open" rather than "the profiles screen is open" — because every existing
 * `setScreen('profiles')` call site is a correct request to open settings, and
 * renaming the value would have churned files owned by four different people
 * for no behavioural gain. The section is the second axis: `screen` says
 * whether settings is up, this says what it is showing.
 */
export type SettingsSection =
  | 'profiles'
  | 'models'
  | 'appearance'
  | 'permissions'
  | 'agents'
  | 'cerebro'
  | 'server'
  | 'advanced';

/**
 * How wide the transcript column is allowed to grow.
 *
 * A named set rather than a number, because the three values are not just
 * sizes — they are different reading modes (a measure tuned for prose, a
 * measure tuned for diffs, and "use the window"), and each maps to a Tailwind
 * max-width class. A free number would put an arbitrary value in front of a
 * class-name lookup, which is exactly the read that has to be validated.
 */
export type ConversationWidth = 'comfortable' | 'wide' | 'full';

/**
 * How much of the run-end summary the transcript keeps.
 *
 * The block reports two unrelated things that happen to arrive together: the
 * accounting for a run (duration, turns, tokens, cost) and, when a run does not
 * finish cleanly, *why*. The accounting is noise to someone who is not watching
 * spend; the reason is the only place a failure is ever explained.
 *
 * So the three values are not "on, less, off" — they are how far down the
 * accounting is trimmed, and none of them can hide an error. `'never'` still
 * renders a failed run's message and code, because a run that vanishes without
 * saying it failed is a bug report we would never receive.
 */
export type RunSummary = 'always' | 'failures' | 'never';

/**
 * Which palette the app wears.
 *
 * Three values, and `'system'` is deliberately a value rather than the absence
 * of one. "Follow the machine" is a standing instruction that has to survive
 * the OS changing its mind at sunset, so it cannot be represented as "no
 * preference stored" — that would be indistinguishable from a fresh install and
 * would lose the difference between a user who never chose and one who chose to
 * defer. It is also why {@link resolveTheme} exists: everything downstream of
 * this wants the *resolved* palette, and only the settings control wants the
 * instruction.
 */
export type Theme = 'system' | 'light' | 'dark';

/** The resolved palette — what `<html>` actually wears. Never `'system'`. */
export type ResolvedTheme = 'light' | 'dark';

// Re-exported so a component reaches for the dock's vocabulary through the same
// module it reaches for the state — `state/dock.ts` is the model, not a second
// public surface, and a component importing from both would have to know which
// half lives where.
export { PREVIEW_TAB, sameTab, tabKey, visibleTabs } from './dock';
export type { DockOwner, DockTab, ShownConversation, TerminalRecord } from './dock';

/**
 * Which conversation a preview belongs to.
 *
 * A preview is not a window-level object even though it is drawn at window
 * level: it is a file *this* conversation wrote, and it makes no sense beside a
 * different one. Recorded at open time and checked by {@link reconcileDock},
 * which closes the pane once the conversation it came from is no longer in a
 * column.
 *
 * Now an alias of {@link DockOwner}, which is the same three fields it always
 * had — a preview and a terminal answer "whose is this?" identically, and the
 * rules for doing so are written out once in `state/dock.ts`. The name is kept
 * because it is what the field is called at every use site, and because
 * "preview owner" says something the general name does not.
 */
export type PreviewOwner = DockOwner;

/**
 * What is being previewed, as the pane needs it.
 *
 * The protocol's answer, plus the one thing the renderer knows and the main
 * process cannot: whose it is. Everything else came back from `preview.open` —
 * the renderer builds none of it, and in particular does not construct the URL.
 * That is the shape of the whole feature in one type: the renderer names a path
 * it read out of a tool call, and gets back either something it is allowed to
 * frame or text it can render itself.
 */
export type PreviewState = PreviewOpenResponse & { readonly owner: PreviewOwner };

/**
 * The file the dock is showing, as the viewer needs it.
 *
 * The same construction as {@link PreviewState} — the main process's answer plus
 * the owner only the renderer knows — with one field neither side sent: the line
 * the reference pointed at. `main/files.ts` returns a file, not a location, and
 * `foo.ts:88` means "this file, at 88" to the person who clicked it. Keeping the
 * number here rather than in the response is what stops the same file opened
 * from two different links being two different reads.
 */
export type FileState = FilesReadResponse & {
  /** This tab's identity. Minted on open; the path is not it — see `openFile`. */
  readonly id: string;
  readonly owner: DockOwner;
  /** 1-based, from a `path:line` reference. Absent when the link named no line. */
  readonly line?: number;
};

/** A dismissible message on the error surface. */
export interface Banner {
  readonly id: string;
  readonly level: 'error' | 'warn' | 'info';
  readonly message: string;
  readonly detail?: string;
  readonly ts: number;
}

export interface AppState {
  readonly bridgeMode: BridgeMode;
  readonly version: string;
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly booted: boolean;

  /**
   * The working grid: rows of columns, top to bottom and left to right.
   *
   * Arrays rather than a map because the order *is* the layout. Pane and row
   * objects are stable identities for as long as they are open, so a component
   * that captured one keeps reading the right store as the grid changes around
   * it.
   *
   * Never empty, and no row is ever empty — {@link closePane} drops a row along
   * with its last pane, and refuses to close the last pane in the window.
   */
  readonly grid: readonly PaneRow[];
  /**
   * Conversations that are still running with no column showing them.
   *
   * A run belongs to the main process, not to the column that happened to start
   * it, and the agent does not stop working because the user looked at
   * something else. So leaving a live conversation — ⌘N, opening another
   * session, reloading the window — hands its pane to this list instead of
   * disposing the run, and coming back to that session hands the same pane back
   * to the grid. The pane *is* the conversation: its store holds the run and
   * the parked permission prompts, its transcript holds what has been said. Move
   * the pane and everything arrives intact, with no replay and nothing to
   * reconcile.
   *
   * Panes here are otherwise ordinary. They receive the mirrored window values
   * ({@link mirrorToPanes}), they own their runs' events ({@link paneForRun}),
   * and they count towards the live-poll rate — the only thing they lack is a
   * cell in the grid.
   *
   * Bounded by the runs themselves: an entry is dropped when its run ends, at
   * which point the provider has written the session to disk and reopening it
   * from the sidebar is a full-fidelity read. Nothing accumulates here across a
   * working day.
   */
  readonly background: readonly Pane[];
  /**
   * Sessions with work in flight, whether or not a column is showing them.
   *
   * A projection of the panes, maintained by {@link syncRunningSessions},
   * because the sidebar lives in the window store and the truth lives in each
   * pane's. An array rather than a `Set` so the change check is a cheap
   * element-wise compare and the value is stable between real changes.
   */
  readonly runningSessions: readonly SessionId[];
  /**
   * Sessions that have stopped and are waiting on *you*.
   *
   * The same projection {@link runningSessions} is, computed in the same walk
   * and for the same reason, but a strictly more urgent fact: a running
   * conversation needs nothing from anybody, while one of these has parked and
   * will stay parked until someone answers it. Kept apart rather than folded
   * into a status enum because the two are read by different surfaces — the
   * sidebar dot wants to know which of the two a row is, and the header badge
   * only ever counts these.
   */
  readonly waitingSessions: readonly SessionId[];
  /**
   * Sessions the **main process** says are still working, as of the last poll.
   *
   * The one fact in this store that is not a projection of the panes, and it is
   * here because the panes cannot know it. Delegated work outlives the run that
   * launched it, and `background.tasks` is a run event — the adapter stops
   * emitting it at `run.end` while keeping the provider process alive for
   * exactly that work. So between one turn ending and the next opening, a
   * column's rows are frozen and this is the only thing that moves.
   *
   * Read as **"keep these"**, never as "the rest are finished". A provider whose
   * adapter cannot answer contributes nothing, so absence from this set means
   * "not known to be working" — see `RunsLiveWorkResponse`. Everything that
   * consumes it therefore widens what counts as live ({@link isWorking}) rather
   * than narrowing it.
   *
   * An array rather than a `Set`, for the reason {@link runningSessions} gives:
   * it is compared element-wise so the value stays stable between real changes.
   */
  readonly sessionsHoldingWork: readonly SessionId[];
  /**
   * Sessions a column is showing right now — what the sidebar marks as open.
   *
   * The same projection {@link runningSessions} is, maintained by the same
   * subscription ({@link syncOpenSessions}), and it exists for the same reason:
   * the row lives in the window store and the answer lives in each pane's, so a
   * selector that reached across the two would only be re-evaluated when the
   * *window* happened to change. That is precisely how this broke — the marker
   * read `resumeSessionId` out of the panes from inside a `useApp` selector, so
   * resuming a session lit its row only when some unrelated window write came
   * along to force the repaint.
   *
   * Two differences from `runningSessions`, and both are the point:
   *
   *  - **Visible columns only.** A backgrounded conversation has no column, so
   *    it is not open; it is already marked as *working* by the running dot,
   *    which is the true thing to say about it. Marking it open as well would
   *    claim a column the user cannot find.
   *  - **One id per pane, not both.** {@link sessionShownBy} answers "which
   *    session is this column showing", and a column shows one. `runningSessions`
   *    lists both ids because either may name work in flight; "open" is a
   *    question about a column, and a fork is showing the new session, not the
   *    history it came out of.
   *
   * Never persisted: it describes this window's columns, and a stale copy would
   * mark rows that nothing is showing.
   */
  readonly openSessions: readonly SessionId[];
  /**
   * Sort keys held still for the sessions being written right now.
   *
   * The sidebar orders rows by `updatedAt`, which is the transcript file's
   * mtime, and a working agent rewrites that file every few seconds. With one
   * session running nobody notices — it is already at the top. With several,
   * every poll re-answered "who wrote most recently" with a different name, so
   * rows swapped places while the user was reading them, roughly every four
   * seconds. Rows are positioned by index, so they teleport; a list that
   * reshuffles under the pointer is also a list that opens the wrong session.
   *
   * The headings above them used to be dragged around by the same numbers, and
   * are not any more: a project sits where its name puts it. This holds the rows
   * still inside one.
   *
   * So a session's position is pinned when it starts running and released when
   * it stops: `updatedAt` stays truthful and this is consulted *instead of* it
   * while an entry exists — see {@link sessionOrderKey}. The held value is the
   * moment the run was first seen, so starting one still lifts its row to the
   * top; what changes is that it then stays there instead of trading places with
   * every other agent that happens to flush a line. Releasing the hold hands the
   * row back to its real mtime, which by then is a few seconds old, so a run
   * ending moves nothing.
   *
   * Rows are therefore ordered by "most recently started or written", and they
   * only ever move on something the user did. Project headings do not use this
   * at all — they sort by name and stay put; see `sessionGroups.ts`.
   *
   * Keyed by bare {@link SessionId}, like {@link runningSessions} beside it and
   * the row marker that reads it.
   *
   * Never persisted. It describes runs in flight in this window, and a stale
   * hold restored from disk would pin a row for a conversation that ended
   * yesterday.
   */
  readonly sessionOrderHold: Readonly<Record<SessionId, number>>;
  /**
   * Which pane the window-level surfaces act on.
   *
   * The palette, the run inspector, the settings dialog and every hotkey are
   * singletons over a grid of conversations, so each needs an answer to "which
   * one". Focus follows a click anywhere in a pane, and every pane is captioned
   * with the focused one marked, so the answer is never a guess.
   */
  readonly focusedPaneId: PaneId;
  /**
   * Divider positions, as percentages, keyed by *position* rather than by id.
   *
   * `row:0`, `row:1`… are the row heights; `r0c1` is the second column of the
   * first row. Positional keys are the point: pane and row ids are minted per
   * session and mean nothing after a restart, whereas "the first divider in the
   * top row" is the same place tomorrow. It is what lets a geometry the user
   * dragged survive closing a pane and opening another one — and survive a
   * relaunch, for whatever shape they rebuild.
   *
   * A shape with no stored entry simply splits evenly; see `WorkingArea`, which
   * only hands the library a layout when it has one for every panel in a group.
   */
  readonly paneLayout: Readonly<Record<string, number>>;
  /**
   * The page the preview pane is showing, or `null` when there is no such pane.
   *
   * Window-owned rather than pane-owned, and that is a claim about what a
   * preview *is*: not part of a conversation, but a thing the window is showing
   * you — the same status as the palette or the settings dialog. One at a time,
   * for the same reason there is one palette. Opening a second artifact
   * replaces the first, which is also what makes the affordance safe to put on
   * every tool card without the grid filling up with frames.
   *
   * Deliberately not persisted. A {@link PreviewState.url} names a snapshot the
   * main process is holding in memory; after a restart there is nothing behind
   * it, and restoring one would reopen the pane onto a 404.
   */
  readonly preview: PreviewState | null;
  /**
   * Every file the dock is showing as text, in the order they were opened.
   *
   * Window-owned, for the reason {@link preview} is. It used to be one at a
   * time as well, and that half is gone: see the `file` variant of `DockTab`
   * for why a vertical strip can afford a tab each, and why reading two files
   * together is worth more than a strip that can never be crowded.
   *
   * The *contents* are still not persisted. What a restore reopens is the
   * paths, read again from disk — see `DockLayout.files`. Restoring the bytes
   * would show a file as it was last week under a caption implying it is
   * current.
   */
  readonly files: readonly FileState[];
  /**
   * Every terminal this window is holding, oldest first.
   *
   * The other half of the dock, and the half that behaves differently in the one
   * way that matters: a record here is **not** removed when its conversation
   * leaves the screen. It stops being drawn — see {@link visibleTabs} — and its
   * shell goes on running, because the shell is very often the point (`pnpm
   * dev`, `tail -f`, an ssh session) and killing it because the user clicked
   * another row in the sidebar would make terminals unusable. Only
   * {@link closeTerminal} ends one.
   *
   * Not persisted, and for a stronger reason than the preview's: a pseudo-
   * terminal cannot outlive the process that owns it, so after a restart there
   * is nothing on the other end of any of these. `bootstrap` re-reads them from
   * the main process instead, which is the only source that can be right.
   */
  readonly terminals: readonly TerminalRecord[];
  /**
   * Every page this window has open, in the order they were opened.
   *
   * Beside {@link terminals} rather than inside it, and holding no page content
   * of any kind — a browser's *contents* live in the main process, and what is
   * here is the id, the owner, and the address bar's worth of state. See
   * `protocol/browser.ts` for why the renderer never holds the page.
   */
  readonly browsers: readonly BrowserRecord[];
  /**
   * Delegated agents the user has opened into tabs of their own.
   *
   * Not persisted, for the terminal's reason rather than the preview's: each
   * one holds a live `TranscriptModel` built by replaying a file, and rebuilding
   * that on demand is a read the next click pays for anyway. What *is* worth
   * keeping across navigation is the tab itself, which is why these outlive
   * their conversation leaving the screen — see {@link visibleTabs}.
   */
  readonly agentViews: readonly AgentView[];
  /**
   * Which dock tab is on top, or `null` when the rail is closed.
   *
   * Held rather than derived because it is a *choice* — the user clicked a tab —
   * and the visible set changes underneath it constantly as conversations come
   * and go. {@link reconcileDock} is what keeps the two consistent, moving this
   * only when the tab it names stops being visible.
   */
  readonly activeDockTab: DockTab | null;
  /**
   * The tabs to draw, left to right. Derived, but *stored*.
   *
   * Stored because the answer depends on both halves of the state — the window's
   * `preview` and `terminals`, and every pane's own run and session — and a
   * selector cannot subscribe to both. A component reading it through `useApp`
   * would never re-render when the *pane* half changed, which is exactly when a
   * tab appears or disappears. `mirrorToPanes` exists for the same reason, and
   * its comment makes the general argument.
   *
   * {@link reconcileDock} is the only writer, and it is also the only writer of
   * {@link activeDockTab}. Everything that changes the dock writes `preview` or
   * `terminals` and lets the subscription settle the rest — which is what keeps
   * "which tab is in front after this" from being answered slightly differently
   * in five places.
   */
  readonly visibleDockTabs: readonly DockTab[];

  readonly providers: readonly ProviderDescriptor[];
  readonly profiles: readonly ProfileMetadata[];

  /**
   * Last-known login state per profile, keyed by id.
   *
   * Cached here rather than fetched per component because reading it costs a
   * subprocess: the profile screen polls while a user signs in, and the status
   * line wants the same answer to decide whether to show a "needs setup"
   * marker. One writer, several readers.
   *
   * A missing entry means "not looked up yet", which is distinct from a looked
   * -up `{ loggedIn: false }` and must not be rendered as signed out.
   */
  readonly authByProfile: Readonly<Record<ProfileId, AuthStatusInfo>>;

  /**
   * Last-known plan usage per profile, keyed by id.
   *
   * Filled by the main process's poller — see `installPlanUsageFeed` — rather
   * than by anything in this window asking. That is what makes the comparison
   * in {@link planRecommendation} possible at all: a per-component fetch can
   * only ever know about the profile that component is looking at, and "which
   * account has the most room" is a question about the ones you are *not*
   * looking at.
   *
   * Not persisted, for the reason the main process does not persist its own
   * cache: a utilization figure restored from disk describes a plan as it was
   * whenever the app was last quit, and it would look exactly as authoritative
   * as a fresh one.
   */
  readonly planUsageByProfile: Readonly<Record<ProfileId, PlanUsage>>;

  /**
   * Model ids the user pinned to the status-line picker, in no particular
   * order — display order comes from the catalogue, not from this.
   *
   * Empty means "not curated", which {@link quickModels} renders as the whole
   * catalogue. That is not the same as "pinned nothing": a user who has never
   * opened settings must still get a usable picker, so there is no way to
   * express an intentionally empty quick list and no need for one.
   *
   * Keyed by profile, because catalogues are not comparable. A Claude account
   * offers a handful of models and an OpenCode one reaches hundreds across
   * twenty providers, so a single shared shortlist is either swamped by the
   * large catalogue or empty for it — and "pinned nothing" reads as the whole
   * catalogue, which turns the swamped case into no shortlist at all.
   *
   * This was once one array for the window, on the reasoning that a shortlist
   * states which models the *user* likes rather than anything about an account.
   * That holds only while every account offers roughly the same lineup. It
   * stopped holding when a provider arrived whose catalogue is two orders of
   * magnitude larger, which is the situation the pins exist to make bearable.
   *
   * Still window-owned and mirrored into every pane: the map is the same for
   * both columns, and each pane resolves its own entry through its
   * `activeProfileId`. See `quickModels`.
   */
  readonly quickModelIdsByProfile: Readonly<Record<ProfileId, readonly string[]>>;
  /**
   * The model choice each conversation was last left on, newest key last.
   *
   * `model`, `effort`, `fastMode` and `ultracode` live in the pane, which is
   * right — they describe what the next prompt in *this column* will do. But a
   * pane outlives the conversation inside it: clicking a row in the sidebar
   * points the same column at a different session, and every one of these came
   * along. That made the model a property of the column rather than of the
   * work, and returning to a long conversation run on Opus put it on whatever
   * the last thing you looked at was using — a change of model, mid-thread,
   * that nothing on screen marked.
   *
   * So the choice is filed under the conversation it was made for, exactly as
   * {@link SessionState.parkedDrafts} files a half-written prompt, and handed
   * back when the column returns. A session with no entry changes nothing: the
   * column keeps what it was using, because blanking the picker on every first
   * open would be a worse answer than carrying the obvious one forward.
   *
   * Window-owned rather than per pane — unlike the drafts, which stay with
   * their column — because the same conversation opened in the other column is
   * the same conversation, and it is not mirrored into panes because nothing
   * reads it through a selector. {@link resumeSession} is the only reader.
   *
   * Keyed by bare session id rather than the `profileId:id` of
   * {@link archivedSessions}, and for the case that key exists to handle: when
   * profiles share a store, one conversation is reachable from several
   * accounts, and it is one conversation with one model. Ids are the
   * provider's own UUIDs, so the collision the compound key guards against
   * does not arise here.
   *
   * Capped at {@link MODEL_MEMORY_LIMIT}, oldest first — see
   * {@link rememberModelChoice}.
   */
  readonly modelBySession: Readonly<Record<string, ModelChoice>>;
  /**
   * The dock's arrangement as it was when the app last closed.
   *
   * Read once at boot by `restoreDockLayout` and otherwise inert — it is the
   * *stored* shape, not the live one, and reading it for anything else would be
   * reading a snapshot as though it were the truth.
   */
  readonly dockLayout: DockLayout;
  /** How wide the transcript column may grow. */
  readonly conversationWidth: ConversationWidth;
  /** How much of the run-end accounting the transcript keeps. */
  readonly runSummary: RunSummary;
  /** Base text size in px — what `text-base` renders at. @see clampFontSize */
  readonly fontSize: number;
  /**
   * The palette instruction, not the palette. @see resolveTheme
   *
   * `'system'` is stored as itself and resolved at the point of use, so the app
   * keeps following the machine after the machine changes its mind — which it
   * does, on a schedule, without anyone opening settings.
   */
  readonly theme: Theme;
  /**
   * Whether streaming text fades in a word at a time.
   *
   * On by default, and off is a real answer rather than an accessibility
   * fallback: the fade is there because a delta landing as a block reads as a
   * stutter, and someone who reads faster than the fade resolves is entitled to
   * find that the stutter was the lesser problem. Off is plain text arriving
   * exactly as the model sends it — no pacing, no per-word elements.
   */
  readonly streamingWordFade: boolean;

  /**
   * Whether the model's reasoning is shown in the thread as it arrives.
   *
   * Off by default, which is the transcript's own argument: thinking is context
   * for the answer rather than the answer, so it folds into the activity marker
   * with the work it was reasoning about and opens on a click. See
   * `ActivityGroup` in `state/transcript.ts` for why that is the default.
   *
   * On is the reader saying the reasoning is what they came for. It changes two
   * things together, because either alone is half a setting: the blocks stop
   * being machinery, so they stand in the conversation instead of inside a
   * marker, and they render open — muted prose that streams as the model writes
   * it. Both are retroactive, so the turn already on screen rearranges when the
   * switch moves rather than only the next one.
   */
  readonly showThinking: boolean;

  /**
   * Whether the dock may open, or grow a tab, without the user asking.
   *
   * On by default, which is every behaviour the app has always had: the first
   * artifact of a conversation opens the preview pane by itself, delegated
   * work surfaces the tasks tab mid-turn, and a page an agent opens appears in
   * the strip. Off is one sentence with no exceptions: nothing the *agent*
   * does may open the side pane — only clicks do. The suppressed things stay
   * reachable through their own affordances (the artifact tile's Open, a
   * browser or task revealed by turning this back on), so off hides arrivals
   * rather than destroying them.
   */
  readonly dockAutoOpen: boolean;
  /**
   * Whether the dock's delegated view shows this column's work or every
   * column's. See `_layout.md` item 5.
   *
   * A window value rather than a pane one, and that is the point of it: the
   * question it answers — "is anything, anywhere, still going" — is about the
   * window, and storing the answer per column would make it a different setting
   * depending on which conversation you happened to ask from.
   */
  readonly dockScope: 'pane' | 'all';
  /**
   * Whether Escape stops a run.
   *
   * Only that. Escape also dismisses the palette, closes a dialog and denies a
   * parked permission, and none of those is "stopping the session" — turning
   * this off must not take the key away from them. See the handler in `App.tsx`.
   */
  readonly escapeStopsRun: boolean;
  /**
   * Whether a conversation stops itself and writes a handover when the account
   * it is running on gets close to a plan limit. See `autoHandoff.ts`.
   */
  readonly autoHandoff: boolean;
  /** Which releases this installation is willing to be offered. */
  readonly updateChannel: UpdateChannel;

  /**
   * Whether the user has taken up the shared-`~/.claude` arrangement.
   *
   * A record of intent, not a switch that does anything. Artemis never links
   * these directories itself — the Advanced pane generates a script and the
   * user runs it — so this flag decides which script the pane offers and
   * nothing else. It cannot be derived from disk either: the answer lives in
   * the profile directories of a filesystem the renderer cannot read, and
   * asking the main process would make an IPC round trip out of remembering a
   * checkbox.
   *
   * Because the flag only *claims* the links exist, everything downstream of it
   * is written to be true whether they do or not. The share script is
   * idempotent and the undo script no-ops on a profile that was never linked,
   * so a stale `true` costs a user one script that reports "keep" on every
   * line.
   */
  readonly sharedClaudeConfig: boolean;
  /**
   * Whether the warning behind the shared-config toggle has ever been accepted.
   *
   * Separate from the flag above because "off" has two meanings and they need
   * different panes. Off-and-never-on is a user who has not met this feature,
   * and showing them an undo script for links they do not have is noise. Off-
   * after-on is a user who ran the share script and has just asked to back out,
   * and the undo script is the only thing they came for.
   */
  readonly sharedClaudeConfigAcknowledged: boolean;

  /**
   * Every session the listing returned, ungrouped and unsorted.
   *
   * Spans every project directory when the aggregated listing channel exists —
   * see `sessionsScope`, which the sidebar renders so a partial history is
   * never mistaken for a complete one. The sidebar does the grouping; see
   * `lib/sessionGroups.ts`.
   */
  readonly sessions: readonly SessionSummary[];
  readonly sessionsScope: SessionScope;
  readonly sessionsLoading: boolean;
  readonly sessionsError: string | null;

  /**
   * Which project a working directory belongs to. Directory → project root.
   *
   * The sidebar groups history by project, and a directory is not one: work
   * split into a linked worktree runs in `…/worktrees/some-branch`, which used
   * to appear as a repository of its own and take those sessions out of the one
   * they belong to. The answer needs the filesystem — a `.git` file, and the
   * pointer inside it — so it comes from the main process one directory at a
   * time and is kept here rather than re-asked per render. See `learnProjects`.
   *
   * **Only the directories that group somewhere else are in it.** A repository
   * root maps to itself, which is what the lookup falls back to, so storing it
   * would be a map of the whole history for no answer. That also keeps this
   * object's identity still while a poll re-reads directories it already knows.
   *
   * Not persisted. It is derived from disk and cheap to rebuild, and a stale
   * entry would outlive the worktree it describes.
   */
  readonly projectRoots: Readonly<Record<string, string>>;

  /**
   * Context window size per model, learned as runs finish.
   *
   * The provider only reveals a model's window in the `final` usage snapshot at
   * run end, and a pane's `run` resets every turn — so without somewhere
   * durable to keep it, the context readout can never render while a turn is
   * streaming. Keyed by model because the number is a property of the model,
   * not the session: switching models must not show the previous one's window.
   *
   * Window-scoped, and mirrored into the panes, precisely because it is about
   * the model. A window learned in the left column is just as true in the
   * right, and making each column learn it separately would blank the readout
   * in a freshly split pane for no reason.
   */
  readonly contextWindows: Readonly<Record<string, number>>;
  readonly banners: readonly Banner[];

  readonly screen: Screen;
  /**
   * The settings pane to show while `screen === 'profiles'`.
   *
   * Persisted, so reopening settings lands where the user left it. Kept
   * meaningful even when settings is closed — the value is a *preference*, not
   * a transient — which is why it is not reset by {@link closeSettings}.
   */
  readonly settingsSection: SettingsSection;
  /** Whether the ⌘K command palette is open. */
  readonly paletteOpen: boolean;
  /** Whether the run/capability inspector dialog is open. */
  readonly infoOpen: boolean;

  /**
   * Sidebar geometry. Persisted, because a pane the user resized and then had
   * silently reset on the next launch is worse than one that was never
   * resizable.
   */
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
  /**
   * Directories whose session group is folded shut in the sidebar.
   *
   * Persisted alongside the geometry and for the same reason: it is furniture
   * the user arranged, and re-opening a section they closed on every launch is
   * the same discourtesy as resetting a width they dragged.
   *
   * Holds the *collapsed* directories, not the open ones, so anything not
   * mentioned is open. That polarity is what lets a project the user has never
   * seen — one that first appears long after this was written — arrive expanded
   * rather than folded shut, which would read as the list having lost it.
   *
   * An array rather than a `Set` because it is persisted as JSON and compared by
   * reference for re-renders; a `Set` would need conversion at both ends and
   * gives nothing back at this size.
   */
  readonly collapsedProjects: readonly string[];
  /**
   * Sessions the user has put away — hidden from their project, gathered into
   * the sidebar's Archived section instead.
   *
   * Entries are `sessionKey` values (`profileId:id`), not bare session ids. An
   * id is only unique inside the profile that owns it, so archiving by id would
   * let one profile's session hide another profile's — rare, but silent and
   * untraceable when it happened.
   *
   * **This is Artemis's own bookkeeping, and deliberately so.** Archiving is
   * the one operation in this menu that does not touch the provider's store:
   * the transcript is untouched, still resumable, and still listed by the
   * provider's own CLI. That is the whole distinction from delete — one hides a
   * row, the other destroys a file — and keeping the two in different places
   * is what makes it impossible to implement one as the other by accident.
   *
   * A key here for a session that no longer exists is harmless and is swept on
   * delete; nothing resolves these keys back into sessions except by filtering
   * a list that only contains real ones.
   */
  readonly archivedSessions: readonly string[];
  /**
   * Whether the sidebar's Archived section is open.
   *
   * Stored with the opposite polarity to {@link collapsedProjects}, and
   * deliberately: a project nobody has touched should be open, whereas the
   * archive should be shut until asked for. Both defaults fall out of "absent
   * from the preferences file", so neither needs seeding — and expressing this
   * as another entry in `collapsedProjects` would have given it the wrong one.
   */
  readonly archivedExpanded: boolean;
  /**
   * Sessions the user has kept up front — lifted out of their project into the
   * sidebar's Pinned section, above every project heading.
   *
   * The mirror image of {@link archivedSessions} and stored the same way, as
   * `sessionKey` values (`profileId:id`) rather than bare ids, for the same
   * reason: an id is only unique inside the profile that owns it, so pinning by
   * id would let one profile's session pin another profile's.
   *
   * Artemis's own bookkeeping too — nothing on disk changes, and the provider
   * has never heard of it. That is what makes it work against every provider,
   * including one whose CLI cannot list its own history.
   *
   * **A session cannot be pinned and archived at once.** The two say opposite
   * things about the same row, so each toggle clears the other rather than
   * leaving a row that is both kept in front of the user and put away. See
   * {@link toggleSessionPinned}.
   */
  readonly pinnedSessions: readonly string[];
  /**
   * Whether the sidebar's Pinned section is folded shut.
   *
   * Stored collapsed-side-out like {@link collapsedProjects}, and the opposite
   * way round from {@link archivedExpanded} — the polarity is the default.
   * Pinning a session is a deliberate request to keep it in view, so the section
   * it creates opens; the archive is where things go to stop being in view, so it
   * stays shut. Both defaults fall out of "absent from the preferences file".
   */
  readonly pinnedCollapsed: boolean;
  /**
   * Directories worked in, capped at {@link RECENT_FOLDERS_LIMIT}.
   *
   * The folder control above the composer is a list of these rather than a
   * chooser, because moving between a handful of projects is the common case and
   * re-navigating a native file dialog to a directory the app already knows
   * about is the tax that made it uncommon. The dialog is still there behind
   * "Add folder…" — this is a shortcut past it, never a replacement.
   *
   * ## Held most-recent-first, shown alphabetically
   *
   * The order here is the *eviction* order and nothing else: recency is what
   * decides which folder falls off the end when an eleventh is opened, because
   * "the one I have not touched in the longest" is the only defensible answer to
   * that. It is deliberately not the order the menu draws.
   *
   * A list sorted by recency rearranges itself under the user — the folder that
   * was second is first the moment you use it, so the row you are aiming at is
   * never where it was last time and the menu has to be read every single time
   * it is opened. Alphabetical is stable: a folder's position is a property of
   * its name, so it can be found by muscle memory. Both surfaces that render
   * this sort it with `sortFoldersByName`.
   *
   * Window-scoped, not per column. Where the user has *been* is a fact about the
   * user; a split does not give them two histories, and a folder opened in the
   * right column is just as worth offering in the left.
   *
   * Entries are absolute paths exactly as adopted — the same strings `cwd`
   * holds, so membership and "is this the current one" are both plain equality.
   * Nothing here is verified to still exist: the renderer cannot stat a path,
   * and a folder that has since been moved fails loudly at the point of use
   * (`main/validate.ts`) rather than being silently dropped from a list the user
   * curates by hand. That curation is {@link forgetFolders}, in Appearance.
   */
  readonly recentFolders: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

const PREFS_KEY = 'artemis.prefs.v1';

/** Sidebar width bounds. Narrower than the minimum stops being a list. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 460;
export const SIDEBAR_DEFAULT_WIDTH = 272;

/** Keep a width inside the bounds, and reject anything that is not a number. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Follow the machine, until told otherwise.
 *
 * The app shipped dark-only, so `'dark'` would be the compatible default — and
 * it is the wrong one. A user on a light-mode machine who installs this build
 * has already told their OS what they want, and defaulting to `'system'` is the
 * only value that hears it. The two agree for everyone who was here before,
 * because a dark-mode machine resolves to the palette they already had.
 */
export const DEFAULT_THEME: Theme = 'system';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * What the OS is asking for.
 *
 * Falls back to dark rather than light when there is no `matchMedia` at all —
 * a Node-environment test, or jsdom, which does not implement it. Dark is what
 * this app looked like before any of this existed, so the no-information answer
 * is the historical one rather than a surprise. The boot script in `index.html`
 * makes the same call for the same reason, and the two have to agree or the
 * first paint and the first render disagree.
 */
function prefersDark(): boolean {
  return globalThis.matchMedia?.(DARK_QUERY).matches ?? true;
}

/** Turn the stored instruction into the palette it currently means. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
}

/**
 * Put the resolved palette on `<html>`, where `index.css` reads it.
 *
 * Both classes are written every time, one on and one off, rather than only
 * adding the one that applies. `index.html` ships `class="dark"` from its boot
 * script and `@custom-variant dark` keys off exactly that class, so a pass that
 * only ever *added* would leave `.dark` in place under the light palette and
 * every registry component's `dark:` variant would fire against light tokens —
 * a failure that looks like a handful of unrelated components being broken
 * rather than like a theme bug.
 *
 * Called at module load as well as from {@link setTheme}, for the reason
 * {@link applyFontScale} is: the first paint has to already be right.
 */
function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  const root = globalThis.document?.documentElement;
  if (root) {
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', resolved === 'light');
  }
  return resolved;
}

/**
 * Text size, in px, measured as the size `text-base` comes out at.
 *
 * The stored number is the one the user is shown, and it is a real px figure
 * rather than a percentage or a t-shirt size because this is the rare setting
 * where the number is the thing being chosen — "14px" is actionable in a way
 * that "Medium" is not. It is deliberately unlike `conversationWidth`, which is
 * named after reading modes precisely because its pixel figure is not.
 *
 * `FONT_SIZE_DEFAULT` must stay equal to `--text-base` in `index.css` (0.875rem
 * against a 16px root). It is the divisor in {@link fontScale}, so the two
 * drifting apart would not break the app — it would silently redefine what
 * "14px" on the dial means.
 *
 * The bounds are where the layout still holds rather than where the text is
 * still legible. Below 11 the 2xs chrome labels stop being readable; above 20
 * the status line runs out of room on a laptop display before anything else
 * does.
 */
export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 14;

/** Keep a text size inside the bounds, and reject anything that is not a number. */
export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

/** The multiplier `--font-scale` carries: 1 at the default, so unset means unchanged. */
export function fontScale(size: number): number {
  return clampFontSize(size) / FONT_SIZE_DEFAULT;
}

/**
 * Push the text size onto `<html>`, where `index.css` reads it.
 *
 * Called once at module load and again from {@link setFontSize}, rather than
 * from an effect in `App`. The load-time call is the point: a `useEffect` would
 * paint one frame at the default size and then resize the whole window, which
 * on a large setting is a visible lurch on every launch. Writing the variable
 * while the store is still initialising means the first paint is already right.
 *
 * Guarded the same way `localStorage` is a few lines down — the store is
 * imported by Node-environment tests that have no `document`.
 */
function applyFontScale(size: number): void {
  globalThis.document?.documentElement.style.setProperty('--font-scale', String(fontScale(size)));
}

/* -------------------------------------------------------------------------- */
/* Recent folders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How many directories the folder menu remembers.
 *
 * Ten, because the menu is scanned rather than searched: it opens over the
 * composer and the whole point of it is that the folder you want is visible
 * without reading. Past a dozen rows that stops being true and the list starts
 * competing with the sidebar's project groups, which are already the answer to
 * "everywhere I have worked" — this is only the answer to "where have I been
 * lately".
 */
export const RECENT_FOLDERS_LIMIT = 10;

/**
 * Put one directory at the front of the list, keeping it deduped and capped.
 *
 * Front, because the stored order is what decides *which folder is dropped* when
 * an eleventh arrives — see {@link AppState.recentFolders}. Re-opening the
 * fourth folder down promotes it rather than leaving it to age out, so the
 * folders in rotation stay in the list and the one that falls off is the one
 * nobody has opened in ten projects' time. Neither menu draws them in this
 * order.
 *
 * Blank paths are dropped: an unconfigured window has `cwd === ''`, and "" is
 * not a folder anyone can go back to.
 */
function promoteFolder(folders: readonly string[], path: string): readonly string[] {
  const next = path.trim();
  if (next.length === 0) return folders;
  // Already at the front — return the same array so subscribers do not re-render
  // for a write that changed nothing. Ordinary: every `setCwd` records.
  if (folders[0] === next) return folders;
  return [next, ...folders.filter((folder) => folder !== next)].slice(0, RECENT_FOLDERS_LIMIT);
}

/* -------------------------------------------------------------------------- */
/* Grid geometry                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How many conversations a window may hold, whatever shape they are in.
 *
 * One number rather than a limit per axis, because the cost being bounded is
 * *a pane* — a live provider subprocess, a transcript, a scroll position and an
 * account being billed — and that cost is the same whether the pane sits in a
 * row or a column. A per-axis cap would bound the wrong thing: eight across and
 * eight down would permit sixty-four agents running at once, which is a
 * fundamentally different machine load from the eight the ceiling is meant to
 * describe.
 *
 * ## What the number is actually bounding
 *
 * Eight concurrent provider subprocesses, in the worst case where every pane is
 * running. That is the real ceiling — not the layout, which stops being usable
 * well before it: {@link SPLIT_MIN_WIDTH} is a pixel floor, so eight columns in
 * one row want 2880px of working area and the panel library clamps rather than
 * granting it. The shapes that fit are the stacked ones — four rows of two, two
 * rows of four — and the limit does not try to know which, because "will this
 * fit on this display" is a question about the window, not about the grid.
 *
 * Everything downstream derives from this constant rather than restating it:
 * {@link canSplit}, {@link SPLIT_LIMIT_REASON} and the per-pane selector cache
 * in {@link memoisePerPane} all read it, so moving it moves them together. That
 * is deliberate — a hardcoded copy in the cache would silently reintroduce the
 * eviction loop the moment this number went up.
 */
export const MAX_PANES = 8;

/**
 * The narrowest a column may be dragged, and the shortest a row, **in pixels**.
 *
 * Sizes, not fractions, and the distinction is the whole point. A percentage
 * floor is a different promise on every window: a quarter of a wide display is
 * a perfectly usable column, and a quarter of a laptop window is 280px — narrow
 * enough that the permission card's buttons stack, the status line drops
 * segments and the composer shows four words at a time. The constraint being
 * expressed is "enough room to read a tool call and type a reply", and that is
 * measured in pixels.
 *
 * The height floor is the tighter of the two in practice: a row has to fit a
 * caption, a composer and a status line before any transcript is visible at
 * all, which is most of 220px before anything is readable.
 *
 * Closing a pane is the deliberate way to get rid of one, and it is one click
 * away; a divider does not need to be able to do it by accident.
 */
export const SPLIT_MIN_WIDTH = 360;
export const SPLIT_MIN_HEIGHT = 220;

/**
 * Sanity bounds for a *stored* divider position.
 *
 * Deliberately looser than the pixel floors above, and not a second copy of
 * them. The real minimum is enforced by the panel group, which knows how large
 * the window actually is; this only stops a hand-edited or corrupt preference
 * from restoring a pane at 2%. Clamping here to match the pixel rule would be
 * guessing at a window size this module cannot see.
 */
const LAYOUT_FLOOR = 5;

/** Keep one stored divider position sane, and reject non-numbers. */
function clampLayoutShare(percent: number): number | null {
  if (!Number.isFinite(percent)) return null;
  return Math.min(100 - LAYOUT_FLOOR, Math.max(LAYOUT_FLOOR, Math.round(percent * 100) / 100));
}

/** Keep only the entries that are usable percentages. */
function cleanLayout(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const share = typeof entry === 'number' ? clampLayoutShare(entry) : null;
    if (share !== null) out[key] = share;
  }
  return out;
}

/** The default reading width, and the fallback for a value that fails validation. */
export const DEFAULT_CONVERSATION_WIDTH: ConversationWidth = 'comfortable';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'profiles',
  'models',
  'appearance',
  'permissions',
  'agents',
  'cerebro',
  'server',
  'advanced',
];

const CONVERSATION_WIDTHS: readonly ConversationWidth[] = ['comfortable', 'wide', 'full'];

/** Show the whole block. What the app did before this was settable. */
export const DEFAULT_RUN_SUMMARY: RunSummary = 'always';

const RUN_SUMMARIES: readonly RunSummary[] = ['always', 'failures', 'never'];

/*
 * REMOVED: `planMeterFocus`, and the default and guard that went with it.
 *
 * It named which single plan-limit window the status bar counted down. The bar
 * is three rings now — 5-hour, weekly, per-model — so there is nothing left to
 * choose between. A value left in the persisted blob by an older build falls
 * through `...(raw as Prefs)` unread and is dropped on the next save.
 */

/**
 * What is persisted, and whose it is.
 *
 * Everything above `sidebarCollapsed` describes a *session*, and with two
 * columns open there are two of each. Only the focused column's is written —
 * see {@link savePrefs} — because these are seeds for the next launch, which
 * starts with one column. Persisting both would mean restoring both, and a
 * split that reappeared on every start (with two sessions the user had since
 * finished) is furniture nobody asked for; the split itself is deliberately
 * not restored. The divider's position is, so re-splitting lands where it was
 * left.
 */
interface Prefs {
  /**
   * The last directory worked in, restored as the starting point for the first
   * session of the next launch.
   *
   * Persisting it does not make it window state: it is a seed, and the moment a
   * session is selected the directory follows that session instead. The
   * alternative — launching with no directory — would block every run behind a
   * folder picker on each start, which is a worse answer to "whose property is
   * this" than remembering where the user was.
   */
  cwd?: string;
  /**
   * The directories offered by the folder menu, most recent first.
   *
   * Persisted for the same reason `cwd` is, only more so: a list of "where I
   * work" that emptied on every launch would be a shortcut that is never there
   * when it is wanted. Seeded from `cwd` on the first launch after this landed —
   * see {@link initialRecentFolders} — so the menu is never introduced empty to
   * a user who has been using the app for weeks.
   */
  recentFolders?: readonly string[];
  paneLayout?: Record<string, number>;
  activeProfileId?: string | null;
  activeProviderId?: ProviderId;
  permissionMode?: PermissionMode;
  model?: string | null;
  effort?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  collapsedProjects?: readonly string[];
  archivedSessions?: readonly string[];
  archivedExpanded?: boolean;
  pinnedSessions?: readonly string[];
  pinnedCollapsed?: boolean;
  settingsSection?: SettingsSection;
  quickModelIdsByProfile?: Readonly<Record<string, readonly string[]>>;
  /**
   * The model choice each conversation was left on. See
   * {@link AppState.modelBySession}.
   *
   * Persisted for the reason the whole feature exists: a conversation returned
   * to tomorrow is the same conversation, and the model it was being run on is
   * a fact about it rather than about this launch. The `model` field above
   * stays what it has always been — the seed for the *first, blank* session of
   * the next launch, which has no id to be looked up under.
   */
  modelBySession?: Record<string, ModelChoice>;
  dockLayout?: unknown;
  fastMode?: boolean;
  ultracode?: boolean;
  conversationWidth?: ConversationWidth;
  runSummary?: RunSummary;
  fontSize?: number;
  theme?: Theme;
  streamingWordFade?: boolean;
  showThinking?: boolean;
  dockAutoOpen?: boolean;
  dockScope?: 'pane' | 'all';
  escapeStopsRun?: boolean;
  autoHandoff?: boolean;
  /**
   * Persisted rather than derived: it is a standing choice about risk, and the
   * app must not quietly move someone between channels across a restart.
   */
  updateChannel?: UpdateChannel;
  sharedClaudeConfig?: boolean;
  sharedClaudeConfigAcknowledged?: boolean;
  /**
   * Context windows learned from completed runs, keyed by model.
   *
   * Persisted because the provider only reports a model's window at run end.
   * Without this the first turn after every launch would have no total to show
   * — the alternative being a hardcoded table of model specs, which would go
   * stale silently and show a confidently wrong denominator.
   */
  contextWindows?: Record<string, number>;
}

/**
 * Coerce one persisted value to a member of a known set, or `undefined`.
 *
 * Prefs are a JSON blob in localStorage: a hand edit, a downgrade to an older
 * build, or a half-written record all produce values that satisfy the `Prefs`
 * type only because `JSON.parse` was cast. `conversationWidth` in particular
 * reaches a Tailwind class-name lookup, so `"banana"` getting that far would
 * render an unstyled column rather than throw — a bug nobody would trace back
 * to a preferences file. Everything read out of the blob that is not a free
 * string goes through a guard.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Keep only the string members, so one corrupt entry does not void the list. */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The pinned shortlists, per profile — and the migration off the flat one.
 *
 * Builds before this stored a single window-wide `quickModelIds`, which cannot
 * be attributed to a profile after the fact: the array says which models the
 * user pinned and nothing about which account they were looking at.
 *
 * So it is seeded into *every* profile rather than dropped or guessed at. That
 * reads reckless and is not, because a pin is already filtered against the live
 * catalogue at read time — see `computeQuickModels`. A Claude profile keeps the
 * Claude ids and an OpenCode profile matches none of them, which falls back to
 * the whole catalogue: exactly the state that profile was in before. Nothing is
 * lost, nothing is invented, and the first edit to any profile replaces its
 * seeded copy.
 *
 * The seed is keyed by profile id, which `loadPrefs` does not have — so it is
 * carried under a reserved key and resolved by {@link seedQuickModels} once the
 * profile list arrives.
 */
/**
 * What the dock looks like right now, in the form that survives a restart.
 *
 * Read off the *focused* pane rather than every one of them. A split window's
 * two columns own two docks, and a stored layout that reopened both would have
 * to remember which column each tab belonged to — through a restart in which
 * pane identity is minted fresh. The focused column is the one the user was
 * looking at, and restoring that is the honest ninety per cent.
 */
function captureDockLayout(state: AppState): DockLayout {
  const paneId = state.focusedPaneId;
  return {
    browsers: state.browsers
      .filter((record) => record.owner.paneId === paneId)
      .map((record) => record.info.state.url)
      .filter((url) => url.length > 0)
      .slice(0, MAX_RESTORED_BROWSERS),
    terminals: Math.min(
      state.terminals.filter((record) => record.owner.paneId === paneId && !record.exited).length,
      MAX_RESTORED_TERMINALS,
    ),
    files: state.files.filter((one) => one.owner.paneId === paneId).map((one) => one.path),
    preview: state.preview?.path ?? null,
    activeKind: state.activeDockTab?.kind ?? null,
  };
}

function quickModelMap(raw: Record<string, unknown>): Record<string, readonly string[]> {
  const value = raw['quickModelIdsByProfile'];
  const map: Record<string, readonly string[]> = {};

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [profileId, entry] of Object.entries(value as Record<string, unknown>)) {
      const ids = stringList(entry);
      if (ids !== undefined && ids.length > 0) map[profileId] = ids;
    }
  }

  // Only when the new shape is absent entirely. A file carrying both is one
  // this build already wrote, and the legacy key is then a leftover rather than
  // an instruction.
  if (Object.keys(map).length === 0) {
    const legacy = stringList(raw['quickModelIds']);
    if (legacy !== undefined && legacy.length > 0) map[LEGACY_PINS_KEY] = legacy;
  }

  return map;
}

/**
 * Where a pre-migration shortlist waits for the profile list to arrive.
 *
 * Not a profile id and deliberately unable to collide with one — profile ids
 * are generated, this is a sentinel. {@link seedQuickModels} consumes it.
 */
const LEGACY_PINS_KEY = ' legacy';

/**
 * Spread a migrated shortlist across the profiles, once they are known.
 *
 * Called from the same place the profile list is stored. A no-op in every run
 * after the first, because consuming the sentinel is what removes it.
 */
function seedQuickModels(profiles: readonly ProfileMetadata[]): void {
  const state = useApp.getState();
  const legacy = state.quickModelIdsByProfile[LEGACY_PINS_KEY];
  if (legacy === undefined || profiles.length === 0) return;

  const seeded: Record<string, readonly string[]> = {};
  for (const profile of profiles) seeded[profile.id] = legacy;
  useApp.setState({
    quickModelIdsByProfile: { ...seeded, ...withoutLegacy(state.quickModelIdsByProfile) },
  });
  savePrefs();
}

function withoutLegacy(
  map: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  const next = { ...map };
  delete next[LEGACY_PINS_KEY];
  return next;
}

/**
 * Keep only the entries whose value is a usable positive number.
 *
 * `contextWindows` becomes the denominator of the context readout, so a
 * `null`, a string, or a `0` that survived out of the blob would render `NaN%`
 * or divide by zero on a gauge the user reads to decide whether to compact.
 * Same rule as every other non-string field here.
 */
function numberMap(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) out[key] = entry;
  }
  return out;
}

/**
 * The stored preferences text, from the file, or from `localStorage` once.
 *
 * The file is where these live now — see `main/prefs.ts` for why they left
 * `localStorage`, and what it cost while they were there. `localStorage` is
 * kept as the *migration source* and nothing else: an installation that
 * predates the move has its only copy there, and reading it once is the
 * difference between carrying the user's archived sessions across and quietly
 * resetting their sidebar.
 *
 * The migration is a read, not a move. The old copy is left where it is,
 * because a build that has not been updated yet is still reading it, and taking
 * it away would strand that build rather than upgrade it.
 */
function prefsFile(): ArtemisBridge['prefsFile'] | undefined {
  /*
   * Read off the global rather than through `resolveBridge`, and that is not a
   * shortcut — it is the only correct way to reach it from here.
   *
   * `loadPrefs` runs at *module scope*, before anything else in this file, and
   * `resolveBridge` memoises its binding the first time it is called. Calling it
   * here would make preference loading the thing that decides, for the lifetime
   * of the window, whether a bridge exists — and it would decide it earlier than
   * any caller expects. Under test that is fatal and was: 48 of them install
   * their stub after the module graph has loaded, and every one of them was
   * being answered by a binding taken before their stub existed.
   */
  return (globalThis as { artemis?: ArtemisBridge }).artemis?.prefsFile;
}

function storedPrefsText(): string | null {
  const file = prefsFile();
  const stored = file?.read() ?? null;
  if (stored !== null && stored !== '') return stored;

  let legacy: string | null = null;
  try {
    legacy = globalThis.localStorage?.getItem(PREFS_KEY) ?? null;
  } catch {
    legacy = null;
  }
  // Written through immediately, so the next launch reads the file and this
  // branch is never taken again.
  if (legacy !== null && legacy !== '' && file !== undefined) file.write(legacy);
  return legacy;
}

function loadPrefs(): Prefs {
  let raw: Record<string, unknown>;
  try {
    const text = storedPrefsText();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return {};
    raw = parsed as Record<string, unknown>;
  } catch {
    return {};
  }

  // The older fields keep their historical treatment: each is resolved against
  // live data at the point of use — `model` and `effort` against the
  // descriptor, `activeProfileId` against the profile list, `sidebarWidth`
  // through `clampSidebarWidth` — so a bad value there is already inert. The
  // fields added below have no such second gate, which is why they get one
  // here.
  const fastMode = boolOrUndefined(raw['fastMode']);
  const ultracode = boolOrUndefined(raw['ultracode']);

  return {
    ...(raw as Prefs),
    settingsSection: oneOf(raw['settingsSection'], SETTINGS_SECTIONS),
    quickModelIdsByProfile: quickModelMap(raw),
    dockLayout: parseDockLayout(raw['dockLayout']),
    // `setFastMode` / `setUltracode` keep these mutually exclusive, but that
    // only governs values this build writes. A file left behind by a build
    // whose exclusion lived in the controls, or one edited by hand, can carry
    // both — and a contradiction restored at boot is indistinguishable to the
    // user from one the app created. Ultracode wins arbitrarily; what matters
    // is that the pair is coerced to something coherent before anything reads
    // it, not which side of a request the user cannot remember making is kept.
    fastMode: fastMode === true && ultracode === true ? false : fastMode,
    ultracode,
    conversationWidth: oneOf(raw['conversationWidth'], CONVERSATION_WIDTHS),
    runSummary: oneOf(raw['runSummary'], RUN_SUMMARIES),
    // Guarded for the usual reason and one extra: this reaches `classList`, so
    // a stray value out of the blob would put an unknown class on <html>,
    // match no palette, and leave the app wearing whichever one the boot
    // script had already resolved — visibly fine until the user tries to
    // change it and nothing happens.
    theme: oneOf(raw['theme'], THEMES),
    streamingWordFade: boolOrUndefined(raw['streamingWordFade']),
    showThinking: boolOrUndefined(raw['showThinking']),
    dockAutoOpen: boolOrUndefined(raw['dockAutoOpen']),
    dockScope: raw['dockScope'] === 'all' ? 'all' : undefined,
    escapeStopsRun: boolOrUndefined(raw['escapeStopsRun']),
    autoHandoff: boolOrUndefined(raw['autoHandoff']),
    updateChannel: raw['updateChannel'] === 'beta' ? 'beta' : undefined,
    sharedClaudeConfig: boolOrUndefined(raw['sharedClaudeConfig']),
    sharedClaudeConfigAcknowledged: boolOrUndefined(raw['sharedClaudeConfigAcknowledged']),
    contextWindows: numberMap(raw['contextWindows']),
    // Same treatment as `contextWindows`, and for the same reason: these reach
    // a layout engine as percentages, so a string or a negative that survived
    // out of the blob would silently produce a pane of no width.
    paneLayout: cleanLayout(raw['paneLayout']),
    // Filtered rather than passed through: this is compared against directory
    // strings, so a non-string left here by a hand edit would simply never
    // match and fold nothing — a silent no-op is worse than dropping the entry.
    collapsedProjects: stringList(raw['collapsedProjects']),
    // Same treatment, same reason: these are compared against session keys, so
    // a non-string surviving out of the blob would never match and would
    // quietly archive nothing.
    archivedSessions: stringList(raw['archivedSessions']),
    archivedExpanded: boolOrUndefined(raw['archivedExpanded']),
    // And again for the pinned set, which is matched against the same keys.
    pinnedSessions: stringList(raw['pinnedSessions']),
    pinnedCollapsed: boolOrUndefined(raw['pinnedCollapsed']),
    // Same treatment again, and here the entry is rendered rather than matched:
    // a non-string surviving into the menu would reach `lastSegment` and throw
    // on a control the user opens to get *out* of a bad directory.
    recentFolders: stringList(raw['recentFolders']),
    modelBySession: modelChoiceMap(raw['modelBySession']),
  };
}

/**
 * How many conversations' choices to keep.
 *
 * An entry is four short values and the cost of losing one is a conversation
 * that reopens on the column's model instead of its own — the behaviour
 * everything had before this existed, so the floor is the old ceiling. The cap
 * is here because this rides in the preferences file, which is read
 * synchronously at boot before the first paint: unbounded, it would grow by an
 * entry per conversation for as long as the app is installed.
 *
 * Declared up here beside {@link loadPrefs} rather than beside
 * {@link rememberModelChoice}, which is the other caller. `loadPrefs` runs at
 * *module scope*, so a `const` declared further down the file is still in its
 * temporal dead zone when the boot read reaches it — a crash on the second
 * launch and only the second, because the first has no entries to prune.
 */
const MODEL_MEMORY_LIMIT = 400;

/** Drop the oldest entries past the cap. Insertion order is the age order. */
function capModelMemory(map: Record<string, ModelChoice>): Record<string, ModelChoice> {
  const keys = Object.keys(map);
  if (keys.length <= MODEL_MEMORY_LIMIT) return map;

  const kept: Record<string, ModelChoice> = {};
  for (const key of keys.slice(keys.length - MODEL_MEMORY_LIMIT)) {
    kept[key] = map[key] as ModelChoice;
  }
  return kept;
}

/**
 * The per-conversation model choices out of the preferences blob, cleaned.
 *
 * Every field is re-derived rather than trusted: these are spread straight into
 * a pane, so a number where `model` should be would reach the picker's label
 * and the run's `RunInput` alike. An entry that survives is a whole choice —
 * a half-read one would restore a model without the effort it was being run at,
 * which is a combination the user never chose.
 *
 * Truncated on the way in as well as on the way out, so a file grown large by
 * an older build does not stay large for as long as the app is open.
 */
function modelChoiceMap(value: unknown): Record<string, ModelChoice> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

  const map: Record<string, ModelChoice> = {};
  for (const [sessionId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const one = entry as Record<string, unknown>;
    const model = one['model'];
    const effort = one['effort'];
    if (model !== null && typeof model !== 'string') continue;
    if (effort !== null && typeof effort !== 'string') continue;
    map[sessionId] = {
      model: model ?? null,
      effort: effort ?? null,
      fastMode: one['fastMode'] === true,
      ultracode: one['ultracode'] === true,
    };
  }
  return capModelMemory(map);
}

/**
 * The folder list a launch starts from.
 *
 * Normalised rather than trusted: the stored list can carry blanks, duplicates
 * and more than the cap after a hand edit or a build that wrote it differently,
 * and every one of those shows up in the menu as a row that either does nothing
 * or repeats the row above it.
 *
 * The `cwd` fallback is a migration, and a one-line one on purpose. A user
 * upgrading into this feature has a directory they have been working in for
 * weeks and no list; opening the new menu to find it empty would read as the app
 * having forgotten, so the directory it *did* remember becomes the first entry.
 */
function initialRecentFolders(stored: Prefs): readonly string[] {
  let folders: readonly string[] = [];
  // Reversed, so the stored order survives: `promoteFolder` prepends, so
  // replaying oldest-first leaves the most recent back at the front.
  for (const folder of [...(stored.recentFolders ?? [])].reverse()) {
    folders = promoteFolder(folders, folder);
  }
  return folders.length > 0 ? folders : promoteFolder([], stored.cwd ?? '');
}

/**
 * Persist the window's preferences and the *focused* column's session seeds.
 *
 * Which column's is not arbitrary: the focused one is the conversation the user
 * was last in, which is the one worth reopening into. See {@link Prefs}.
 */
function savePrefs(): void {
  const s = useApp.getState();
  const pane = paneState(focusedPane(s));
  const prefs: Prefs = {
    cwd: pane.cwd,
    recentFolders: s.recentFolders,
    activeProfileId: pane.activeProfileId,
    activeProviderId: pane.activeProviderId,
    permissionMode: pane.permissionMode,
    model: pane.model,
    effort: pane.effort,
    fastMode: pane.fastMode,
    ultracode: pane.ultracode,
    paneLayout: s.paneLayout,
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarWidth: s.sidebarWidth,
    collapsedProjects: s.collapsedProjects,
    archivedSessions: s.archivedSessions,
    archivedExpanded: s.archivedExpanded,
    pinnedSessions: s.pinnedSessions,
    pinnedCollapsed: s.pinnedCollapsed,
    settingsSection: s.settingsSection,
    quickModelIdsByProfile: s.quickModelIdsByProfile,
    modelBySession: s.modelBySession,
    dockLayout: captureDockLayout(s),
    conversationWidth: s.conversationWidth,
    runSummary: s.runSummary,
    fontSize: s.fontSize,
    theme: s.theme,
    streamingWordFade: s.streamingWordFade,
    showThinking: s.showThinking,
    dockAutoOpen: s.dockAutoOpen,
    dockScope: s.dockScope,
    escapeStopsRun: s.escapeStopsRun,
    autoHandoff: s.autoHandoff,
    updateChannel: s.updateChannel,
    sharedClaudeConfig: s.sharedClaudeConfig,
    sharedClaudeConfigAcknowledged: s.sharedClaudeConfigAcknowledged,
    contextWindows: s.contextWindows,
  };
  const json = JSON.stringify(prefs);
  const file = prefsFile();
  if (file !== undefined) {
    // One writer, and it is the file. Mirroring into `localStorage` as well
    // would leave two copies that disagree the moment a second build wrote one
    // of them, which is the whole problem the move exists to end.
    file.write(json);
    return;
  }
  // No bridge: a browser preview, or a window whose preload never loaded. There
  // is no second process to share a file with, so the old home is still right.
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, json);
  } catch {
    /* Preferences are a convenience; a full quota is not worth an error. */
  }
}

const prefs = loadPrefs();

/*
 * Resolved once, and applied before the store exists.
 *
 * One constant feeds both the CSS variable and the store's seed below, so the
 * size the window is painted at and the size the settings pane reports cannot
 * disagree — and the clamp runs on the way in, so a hand-edited preferences
 * file cannot open the app at 400px text.
 */
const initialFontSize = clampFontSize(prefs.fontSize ?? FONT_SIZE_DEFAULT);
applyFontScale(initialFontSize);

/*
 * The same treatment for the palette, and it is deliberately a *second* pass
 * over something the boot script in `index.html` has already done.
 *
 * That script runs before the stylesheet paints and reads the same key out of
 * the same blob, so in the overwhelming case this changes nothing and is pure
 * belt and braces. It earns its place in the two cases where the boot script is
 * not enough: a build where the script failed to run at all (a CSP the hash no
 * longer matches, say), and a `localStorage` that was written between the two —
 * which is what a second window opening onto changed preferences looks like.
 * Re-deriving here means the class on <html> and the value in the store cannot
 * disagree, and disagreement is the one state with no visible symptom until
 * something toggles.
 */
const initialTheme = prefs.theme ?? DEFAULT_THEME;
applyTheme(initialTheme);

/*
 * The thinking switch, defaulting to on.
 *
 * On, because reasoning is part of the conversation: the model works out what
 * to say and then says it, and a reader watching an agent work wants both. It
 * is a preference rather than a fact because one block in fifty is four
 * thousand words about a typo — that is what turning it off is for, and the
 * per-block fold is there for the same reason at a finer grain.
 */
const initialShowThinking = prefs.showThinking ?? true;

/**
 * The state a brand-new column starts from.
 *
 * Takes the mirrored window values from whatever is current, so a pane opened
 * an hour into a session does not begin with an empty profile list and a status
 * line full of placeholders for the one frame before the first mirror lands.
 */
function seedSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    providers: [],
    profiles: [],
    sessions: [],
    contextWindows: prefs.contextWindows ?? {},
    quickModelIdsByProfile: prefs.quickModelIdsByProfile ?? {},

    activeProviderId: prefs.activeProviderId ?? 'claude',
    activeProfileId: (prefs.activeProfileId ?? null) as ProfileId | null,
    cwd: prefs.cwd ?? '',
    workspace: null,
    permissionMode: prefs.permissionMode ?? 'default',
    model: prefs.model ?? null,
    effort: prefs.effort ?? null,
    fastMode: prefs.fastMode ?? false,
    ultracode: prefs.ultracode ?? false,
    forkOnResume: false,
    resumeSessionId: null,
    rewindToMessageId: null,
    models: [],
    modelsLoading: false,
    modelsError: null,
    run: null,
    permissionQueue: [],
    tasks: [],
    dismissedTasks: [],
    tasksRequested: false,
    filesRequested: false,
    promptHistory: [],
    handoff: 'none',
    draft: '',
    parkedDrafts: {},
    ...overrides,
  };
}

/**
 * Watch a pane's run state, once.
 *
 * Every pane goes through {@link openPane} — the first at module scope, the rest
 * as they are minted — so a new conversation cannot be forgotten here. The
 * disposer is kept so {@link closePane} can drop it: a live subscription to a
 * closed pane's store would hold the pane, its transcript and every message in
 * it for the life of the window.
 */
const paneWatchers = new Map<PaneId, () => void>();

function unwatchPane(paneId: PaneId): void {
  paneWatchers.get(paneId)?.();
  paneWatchers.delete(paneId);
}

/**
 * What the window recomputes when any conversation changes under it.
 *
 * Three projections rather than one subscription each, because they are
 * triggered by exactly the same events — a run starting, ending, or a session
 * being resumed into a column — and splitting them would only mean walking the
 * panes three times. All are written to be cheap and to write nothing when
 * nothing moved; this runs on every keystroke in a composer, which shares the
 * pane's store.
 */
function syncFromPanes(): void {
  syncRunningSessions();
  syncOpenSessions();
  reconcileDock();
}

/** Mint a conversation the window is already watching. The only way panes are made. */
function openPane(initial: SessionState): Pane {
  const pane = createPane(initial);
  paneWatchers.set(pane.id, pane.store.subscribe(syncFromPanes));
  return pane;
}

const firstPane = openPane(seedSession());

export const useApp = create<AppState>(() => ({
  // Empty rather than the stored layout: this is the state before preferences
  // are read, and `applyPrefs` puts the real one in.
  dockLayout: EMPTY_DOCK_LAYOUT,
  bridgeMode: 'unavailable',
  version: '',
  platform: 'darwin',
  booted: false,

  grid: [createRow([firstPane])],
  background: [],
  runningSessions: [],
  waitingSessions: [],
  sessionsHoldingWork: [],
  openSessions: [],
  sessionOrderHold: {},
  focusedPaneId: firstPane.id,
  paneLayout: prefs.paneLayout ?? {},
  preview: null,
  files: [],
  terminals: [],
  browsers: [],
  agentViews: [],
  activeDockTab: null,
  visibleDockTabs: [],

  providers: [],
  profiles: [],
  authByProfile: {},
  planUsageByProfile: {},

  quickModelIdsByProfile: prefs.quickModelIdsByProfile ?? {},
  modelBySession: prefs.modelBySession ?? {},
  conversationWidth: prefs.conversationWidth ?? DEFAULT_CONVERSATION_WIDTH,
  runSummary: prefs.runSummary ?? DEFAULT_RUN_SUMMARY,
  fontSize: initialFontSize,
  theme: initialTheme,
  // `??`, not `||`: a persisted `false` is the whole point of the setting and
  // must survive a reload.
  streamingWordFade: prefs.streamingWordFade ?? true,
  // Resolved above, because the pane layer had to be told before the first
  // transcript existed. Same constant, so the switch and the fold cannot
  // disagree about what was restored.
  showThinking: initialShowThinking,
  // Same rule: `false` is the deliberate state this pref exists to keep.
  dockAutoOpen: prefs.dockAutoOpen ?? true,
  // This column, unless asked otherwise. The dock tab names a conversation, and
  // opening it to find another one's work would be answering a question nobody
  // asked from a place that says it is about this one.
  dockScope: prefs.dockScope ?? 'pane',
  // Defaults on: this is how Escape has always behaved, and a preference that
  // silently changed an existing reflex would be worse than not having one.
  escapeStopsRun: prefs.escapeStopsRun ?? true,
  // Off unless asked for. Stopping someone's work is the most intrusive thing
  // this app does on its own, and it is not a default anyone opted into.
  autoHandoff: prefs.autoHandoff ?? false,
  updateChannel: prefs.updateChannel ?? 'stable',

  // Both default to false, and the second is what keeps a fresh install from
  // being offered an undo for something it never did.
  sharedClaudeConfig: prefs.sharedClaudeConfig ?? false,
  sharedClaudeConfigAcknowledged: prefs.sharedClaudeConfigAcknowledged ?? false,

  sessions: [],
  sessionsScope: 'all',
  sessionsLoading: false,
  sessionsError: null,
  projectRoots: {},

  contextWindows: prefs.contextWindows ?? {},
  banners: [],

  screen: 'chat',
  settingsSection: prefs.settingsSection ?? 'profiles',
  paletteOpen: false,
  infoOpen: false,

  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  sidebarWidth: clampSidebarWidth(prefs.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH),
  collapsedProjects: prefs.collapsedProjects ?? [],
  archivedSessions: prefs.archivedSessions ?? [],
  archivedExpanded: prefs.archivedExpanded ?? false,
  pinnedSessions: prefs.pinnedSessions ?? [],
  pinnedCollapsed: prefs.pinnedCollapsed ?? false,
  recentFolders: initialRecentFolders(prefs),
}));

/* -------------------------------------------------------------------------- */
/* Panes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every pane in the grid, in reading order.
 *
 * Memoised on the grid's identity, and that is not an optimisation. This is
 * read through `useApp(allPanes)`, which decides whether to re-render by
 * comparing the result by identity; a fresh `flatMap` on every store read would
 * report a change every time and React would loop to its update-depth ceiling.
 * Same hazard `NO_OPTIONS` and `quickModels` describe further down.
 */
let flatGrid: readonly PaneRow[] | null = null;
let flatPanes: readonly Pane[] = [];

export function allPanes(state: AppState = useApp.getState()): readonly Pane[] {
  if (state.grid === flatGrid) return flatPanes;
  flatGrid = state.grid;
  flatPanes = state.grid.flatMap((row) => row.panes);
  return flatPanes;
}

/**
 * Every conversation this window is responsible for — on screen or not.
 *
 * The distinction from {@link allPanes} is exactly "does it have a column".
 * Anything that is about *layout* wants `allPanes`; anything that is about a
 * *conversation* — routing its events, mirroring the window's values into it,
 * deciding whether the app has work in flight — wants this. Getting that wrong
 * is silent: a backgrounded run whose events find no owner simply stops
 * appearing, and the transcript is only missing the part the user was away for.
 *
 * Memoised on both halves for the reason `allPanes` gives: it is read through
 * `useApp`, so a fresh array per read would report a change on every store
 * write.
 */
let livePanesFrom: readonly Pane[] | null = null;
let livePanesBackground: readonly Pane[] | null = null;
let livePanes: readonly Pane[] = [];

export function allLivePanes(state: AppState = useApp.getState()): readonly Pane[] {
  const visible = allPanes(state);
  if (visible === livePanesFrom && state.background === livePanesBackground) return livePanes;
  livePanesFrom = visible;
  livePanesBackground = state.background;
  livePanes = state.background.length === 0 ? visible : [...visible, ...state.background];
  return livePanes;
}

/** How many conversations are open. */
export function paneCount(state: AppState = useApp.getState()): number {
  return allPanes(state).length;
}

/**
 * The pane the window-level surfaces act on.
 *
 * Total by construction: a pane is only ever removed by {@link closePane},
 * which moves the focus first, and the grid can never be empty. The `?? [0]` is
 * belt and braces against a focus id that outlived its pane, which would
 * otherwise crash the palette rather than land somewhere sensible.
 */
export function focusedPane(state: AppState = useApp.getState()): Pane {
  const panes = allPanes(state);
  return panes.find((p) => p.id === state.focusedPaneId) ?? (panes[0] as Pane);
}

/** Where a pane sits, or `null` if it is not in the grid. */
function locate(
  grid: readonly PaneRow[],
  paneId: PaneId,
): { readonly row: number; readonly column: number } | null {
  for (let row = 0; row < grid.length; row += 1) {
    const column = (grid[row] as PaneRow).panes.findIndex((p) => p.id === paneId);
    if (column >= 0) return { row, column };
  }
  return null;
}

/** Which way a split goes. Right adds a column to a row; down adds a row. */
export type SplitDirection = 'right' | 'down';

/**
 * Is there room for one more pane?
 *
 * Asked by the controls so an impossible split is rendered disabled with a
 * reason rather than silently doing nothing — the app-wide rule. It takes no
 * direction because the limit does not have one: {@link MAX_PANES} bounds the
 * window's conversations, not the length of a row.
 */
export function canSplit(state: AppState = useApp.getState()): boolean {
  return paneCount(state) < MAX_PANES;
}

/** The sentence to show when {@link canSplit} says no. */
export const SPLIT_LIMIT_REASON = `A window holds ${MAX_PANES} conversations at once. Close one to open another.`;

/**
 * The pane holding a given run, or `undefined` once it has been closed.
 *
 * Searches backgrounded conversations too, which is what keeps a run the user
 * navigated away from streaming into its own transcript rather than into
 * nothing.
 */
function paneForRun(runId: RunId): Pane | undefined {
  return allLivePanes().find((p) => paneState(p).run?.runId === runId);
}

/** True while any conversation has a live run. Drives the session feed's poll rate. */
export function anyPaneLive(state: AppState = useApp.getState()): boolean {
  return allLivePanes(state).some((pane) => isLive(paneState(pane)));
}

/**
 * The conversation already holding a session, wherever it is.
 *
 * How {@link resumeSession} tells "open this from history" from "go back to the
 * thing you already have open". Matched on the run's own `sessionId` as well as
 * the pane's `resumeSessionId`: the latter is the session the *next* prompt will
 * continue, and for a brand-new conversation it is null until the run ends —
 * precisely the window in which a user is most likely to switch away.
 *
 * ## Every conversation, not just the backgrounded ones
 *
 * This searched `background` alone once, which made a run in a column that is
 * *on screen* invisible to it — so clicking the sidebar row of a session working
 * in the focused pane fell through to the resume path, shoved that run into the
 * background, and replayed the provider's half-written file into a fresh column.
 * The conversation carried on working somewhere the user could not see it while
 * the pane in front of them sat there looking finished, and clicking the row a
 * second time — which *did* find it in the background — brought it back. In a
 * split it was worse: both columns ended up pointed at one session id, so the
 * next prompt from the dead one would start a second run appending to a
 * transcript file another run already owned.
 *
 * `allLivePanes` lists the visible panes first, so a session open both on screen
 * and in the background — which forking can produce — resolves to the one the
 * user can see.
 *
 * The marker on the row has always spanned both (see {@link syncRunningSessions}),
 * and the two must agree: a row that says "running now" and then opens as
 * history is the same disagreement seen from the other end.
 */
/**
 * Can this profile reach this session's transcript?
 *
 * True for the profile the session was read under, and for any other profile
 * sharing that store — see `SessionSummary.alsoInProfiles`. Everything else is
 * false, which is the ordinary answer: a config directory is normally a private
 * store and a session in one is invisible to every other profile.
 *
 * The distinction is about which accounts *may* continue a conversation, not
 * about which one wrote it. With a shared store nothing records the latter, and
 * this deliberately does not pretend otherwise.
 */
export function canReachSession(session: SessionSummary, profileId: ProfileId): boolean {
  return session.profileId === profileId || (session.alsoInProfiles?.includes(profileId) ?? false);
}

function paneForSession(
  sessionId: SessionId,
  state: AppState = useApp.getState(),
): Pane | undefined {
  return allLivePanes(state).find((pane) => {
    const s = paneState(pane);
    return s.run?.sessionId === sessionId || s.resumeSessionId === sessionId;
  });
}

/**
 * Bring the first conversation that is waiting on an answer to the front.
 *
 * "First" is the order `syncRunningSessions` collected them in, which is the
 * order the panes are laid out — so the badge walks left to right rather than
 * by how long each has been parked. Either would be defensible; this one is
 * predictable, and a control the user presses repeatedly should be predictable
 * before it is clever.
 *
 * Returns `false` when nothing is waiting or the pane has since gone, so the
 * caller can leave the badge alone rather than focusing something arbitrary.
 */
export function focusWaitingPane(): boolean {
  const state = useApp.getState();
  for (const sessionId of state.waitingSessions) {
    const pane = paneForSession(sessionId, state);
    if (pane !== undefined) {
      focusPane(pane.id);
      return true;
    }
  }
  return false;
}

/**
 * Recompute {@link AppState.runningSessions} from the conversations themselves.
 *
 * The sidebar needs to know which sessions are working, and "working" is a fact
 * about a *pane's* store — a different store from the window's, which is the one
 * the sidebar subscribes to. A selector that reached across the two would only
 * be re-evaluated when the *window* changed, so a run starting or ending would
 * not repaint the list until something unrelated did. So the fact is copied to
 * the window instead, by a subscription on every pane, and the sidebar reads an
 * ordinary window value.
 *
 * Writes only on a real change: this runs on every keystroke in a composer (the
 * same store holds `draft`), and an unconditional `setState` would re-render the
 * whole session list per character.
 */
function syncRunningSessions(): void {
  const ids: SessionId[] = [];
  /*
   * Collected in the same walk, deliberately.
   *
   * Waiting is a fact about the same pane stores this is already reading, and a
   * second subscription over the same panes would double the work done on every
   * keystroke in a composer for a value that changes on the same beat.
   */
  const waiting: SessionId[] = [];
  // The window value, read once for the whole walk — see `pruneBackground`.
  const holding = useApp.getState().sessionsHoldingWork;
  for (const pane of allLivePanes()) {
    const state = paneState(pane);
    /*
     * `isWorking`, not `isLive`: a session whose agents are still going, marked
     * idle the moment its launching turn ended, is exactly the "nothing tells me
     * anything is running" hole the delegated pane was built to close. The
     * pane's tab only exists while its conversation is on screen; this marker is
     * what says so from the sidebar when it is not.
     *
     * And not `hasLiveWork` either, which closed that hole only as far as the
     * last rows this window was sent. Between turns those stop arriving, so a
     * workflow that settled a row and carried on went unmarked — the sidebar
     * fell quiet while the work ran on. The main process is asked as well.
     */
    /*
     * Waiting is judged *before* the working check and never skipped by it.
     *
     * `activityOf` is the same function the foot of the transcript uses, so the
     * sidebar and the pane cannot disagree about what a conversation is doing —
     * and it already ranks a queued permission above a `running` status, which
     * is the ordering that matters here: a provider that has asked for
     * something is, to the person who has to answer, waiting rather than busy.
     *
     * Outside the `isWorking` guard because a pane can be parked on a
     * permission while `isWorking` says no — the run reports
     * `awaiting_permission` and nothing is being computed. That is precisely
     * the conversation this badge exists to send you back to.
     */
    if (activityOf(state.run, state.permissionQueue.length).kind === 'waiting') {
      if (state.run?.sessionId !== undefined) waiting.push(state.run.sessionId);
      else if (state.resumeSessionId !== null) waiting.push(state.resumeSessionId);
    }

    if (!isWorking(state, holding)) continue;
    /*
     * Both ids, not the better of the two.
     *
     * They are usually the same — resuming a Claude session continues under its
     * own id — but they diverge in two ordinary cases: before `session.started`
     * arrives, when the run has no id of its own yet, and after a fork, where
     * the run's id is new and the row the user clicked still carries the old
     * one. Marking only one of them leaves the conversation running behind a row
     * that looks idle, which is the whole failure this marker exists to prevent.
     * {@link paneForSession} matches on either for the same reason, and the two
     * must agree: a row that cannot be marked but can be opened, or the reverse,
     * is worse than neither.
     */
    if (state.run?.sessionId !== undefined) ids.push(state.run.sessionId);
    if (state.resumeSessionId !== null && state.resumeSessionId !== state.run?.sessionId) {
      ids.push(state.resumeSessionId);
    }
  }

  const state = useApp.getState();
  const sameRunning =
    state.runningSessions.length === ids.length &&
    ids.every((id, i) => state.runningSessions[i] === id);
  const sameWaiting =
    state.waitingSessions.length === waiting.length &&
    waiting.every((id, i) => state.waitingSessions[i] === id);
  // Both compared before writing either: this runs on every keystroke in a
  // composer — the same store holds `draft` — and an unconditional `setState`
  // would re-render the whole session list per character.
  if (sameRunning && sameWaiting) return;
  useApp.setState({
    ...(sameRunning ? {} : { runningSessions: ids, sessionOrderHold: holdOrder(ids) }),
    ...(sameWaiting ? {} : { waitingSessions: waiting }),
  });
}

/**
 * Recompute {@link AppState.openSessions} — which sessions have a column.
 *
 * The sibling of {@link syncRunningSessions}, and it exists because the sidebar
 * marker used to ask this question the wrong way round: it read the panes from
 * inside a `useApp` selector, which subscribes to the *window*. Nothing about a
 * pane can notify that selector, so the marker repainted only when some
 * unrelated window write happened to come along — and the two cases where the
 * user most wants the mark are exactly the two where none does.
 *
 * `allPanes`, not `allLivePanes`: this is the question "is this on screen
 * somewhere", which a backgrounded conversation answers no. It is already
 * marked as working by {@link AppState.runningSessions}, which is the true
 * thing to say about a run with no column.
 *
 * {@link sessionShownBy} rather than either field alone. A column showing a
 * brand-new conversation has a run id and no `resumeSessionId` until the turn
 * ends; a forked one has both, and the new run is what is on screen. Reading
 * `resumeSessionId` by itself was wrong in both — it left the session the user
 * was watching unmarked, and after a fork it marked the history instead.
 *
 * Same shape and same guard as its sibling: an array so the compare is cheap
 * and the value is stable, and no write at all when nothing moved — this runs
 * on every keystroke in a composer.
 */
function syncOpenSessions(): void {
  const ids: SessionId[] = [];
  for (const pane of allPanes()) {
    const id = sessionShownBy(paneState(pane));
    // Two columns can show one session — `paneForSession` reveals rather than
    // opens a second copy, but a fork passes through the state briefly — and a
    // duplicate would make the compare below report a change that is not one.
    if (id !== null && !ids.includes(id)) ids.push(id);
  }

  const current = useApp.getState().openSessions;
  if (current.length === ids.length && ids.every((id, i) => current[i] === id)) return;
  useApp.setState({ openSessions: ids });
}

/**
 * The next {@link AppState.sessionOrderHold}, for a given set of running ids.
 *
 * Mint on the way in, drop on the way out, and never move an entry that is
 * already there — that last part is the whole point, since a hold that were
 * re-stamped would churn exactly like the mtime it replaces.
 *
 * Returns the existing object when nothing changed, so this can sit in the same
 * `setState` as `runningSessions` without putting a fresh record into the store
 * on every keystroke. `Date.now()` rather than the session's own `updatedAt`
 * because a session that has just been resumed still carries the mtime it had
 * when it was last worked on: holding *that* would leave the row the user is
 * typing into wherever it was yesterday. A run starting should lift its row and
 * then hold it, which is what "now" means here.
 */
function holdOrder(
  running: readonly SessionId[],
  previous: Readonly<Record<SessionId, number>> = useApp.getState().sessionOrderHold,
): Readonly<Record<SessionId, number>> {
  const now = Date.now();
  const next: Record<SessionId, number> = {};
  let changed = false;
  for (const id of running) {
    const held = previous[id];
    if (held === undefined) changed = true;
    next[id] = held ?? now;
  }
  // Every id in `previous` that is not in `running` has been dropped, and a
  // shorter record is the only way that shows up in the count.
  if (!changed && Object.keys(previous).length === Object.keys(next).length) return previous;
  return next;
}

/**
 * Where a session sits in the sidebar's order.
 *
 * Its held position while it is being written, and its real mtime otherwise.
 * Exported so the palette and the sidebar sort by the same rule — two lists of
 * the same sessions in two different orders is its own small bug.
 */
export function sessionOrderKey(
  session: SessionSummary,
  hold: Readonly<Record<SessionId, number>>,
): number {
  return hold[session.id] ?? session.updatedAt;
}

/**
 * Copy the window's shared values into every pane.
 *
 * The single writer of the mirrored fields, subscribed to the app store rather
 * than called by each action, so a new `setState` on `profiles` written a year
 * from now cannot forget to propagate. The identity guard is what keeps this
 * off the render path: the subscription fires on every window change (a banner,
 * the palette opening), and without it each of those would push a fresh object
 * into every pane and re-render every status line.
 */
function mirrorToPanes(state: AppState): void {
  const next: MirroredState = {
    providers: state.providers,
    profiles: state.profiles,
    sessions: state.sessions,
    contextWindows: state.contextWindows,
    quickModelIdsByProfile: state.quickModelIdsByProfile,
  };
  // Backgrounded conversations included: one comes home the moment the user
  // clicks its row, and a pane that had been out of the mirror would arrive
  // showing an empty profile list under a status line full of placeholders.
  for (const pane of allLivePanes(state)) {
    const current = paneState(pane);
    if (MIRRORED_KEYS.every((key) => current[key] === next[key])) continue;
    setPaneState(pane, next);
  }
}

useApp.subscribe(mirrorToPanes);

/*
 * The other half of `syncFromPanes`'s trigger.
 *
 * The per-pane subscription catches a run *changing*; this catches the set of
 * panes changing — a conversation moving to the background, coming home, or
 * being adopted from the main process after a reload. Neither alone is enough:
 * backgrounding a pane writes only the window store, and a run ending writes
 * only a pane's.
 *
 * It is also the half that closes an orphaned preview, and closing a column is
 * exactly the case only this half sees.
 *
 * Safe to re-enter. The write inside notifies this subscriber again, and the
 * second pass finds nothing changed and returns.
 */
useApp.subscribe(syncFromPanes);

/*
 * `'system'` is a standing instruction, so something has to keep listening.
 *
 * Without this, "System" would mean "whatever the OS was set to when this
 * window opened" — correct on launch and then quietly wrong at sunset on every
 * machine with a schedule, which is most of them now. The listener is
 * registered for the life of the renderer rather than mounted by a component:
 * there is nothing to unsubscribe from because the page outlives any tree that
 * could own it, and a `useEffect` in `App` would tie the palette to a component
 * that a future refactor is entitled to move.
 *
 * The guard is on every event rather than on registration, because the
 * instruction changes while the listener is alive — a user who picks Dark and
 * later returns to System must not need a reload to be followed again.
 *
 * Registered after the store exists so the callback can read it. Nothing here
 * fires during module evaluation.
 */
globalThis.matchMedia?.(DARK_QUERY).addEventListener('change', () => {
  if (useApp.getState().theme !== 'system') return;
  applyTheme('system');
  // The document changed palette without anything re-rendering, so the one
  // surface that cannot read CSS has to be told. See `setTheme`.
  retheme();
});

/**
 * Choose the palette.
 *
 * Writes the class before the store, so a component reading `theme` in the same
 * tick is never a frame ahead of the document it is describing.
 */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  useApp.setState({ theme });
  // xterm paints into a canvas and was handed literal colours at construction,
  // so it is the one part of the app a stylesheet swap does not reach. Every
  // live terminal is re-themed here rather than on next write, because a
  // terminal the user is not typing into would otherwise keep the old palette
  // until it happened to receive output.
  retheme();
  savePrefs();
}

/** Point the window-level surfaces at a pane. */
export function focusPane(paneId: PaneId): void {
  if (useApp.getState().focusedPaneId === paneId) return;
  useApp.setState({ focusedPaneId: paneId });
  savePrefs();
}

/**
 * Commit dragged dividers.
 *
 * Takes a whole group's worth at once — positional key to percentage — because
 * that is what the panel library reports and because the shares in one group
 * only mean anything together. Clamped here so no caller can persist a silly
 * one, and a no-op write is dropped rather than churning `localStorage` on a
 * layout that merely re-reported itself.
 */
export function setPaneLayout(shares: Readonly<Record<string, number>>): void {
  const current = useApp.getState().paneLayout;
  let changed = false;
  const next: Record<string, number> = { ...current };
  for (const [key, value] of Object.entries(shares)) {
    const share = clampLayoutShare(value);
    if (share === null || current[key] === share) continue;
    next[key] = share;
    changed = true;
  }
  if (!changed) return;
  useApp.setState({ paneLayout: next });
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Show a file the agent wrote, in the preview pane.
 *
 * `path` comes out of a tool call, which is to say out of model output, and is
 * passed straight through: this function deliberately does not decide what may
 * be previewed. The main process reads the file, checks what it is and answers
 * with a URL or with a sentence, and that is the only place the rules live —
 * a second copy of them here could only ever drift out of agreement with the
 * one that matters.
 *
 * A failure lands in `pane`'s transcript rather than on the error surface. The
 * banner list is for things that break the app; failing to preview one file is
 * a fact about that tool call, and it belongs next to it where the reader is
 * already looking.
 */
export async function openPreview(path: string, pane: Pane = focusedPane()): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const res = await call(() => bridge.preview.open({ path }));
  if (!res.ok) {
    pane.transcript.note('warn', 'Could not preview this file', res.error.message);
    return;
  }

  /*
   * Ownership is read *after* the await, not before. The read is deliberate:
   * between naming the path and getting the bytes back the user may have
   * resumed a different session into this column, and stamping the preview with
   * the conversation that was there when the click happened would hand it an
   * owner that is already gone — `reconcilePreview` would then close it
   * immediately, which looks like the button not working.
   */
  useApp.setState({
    preview: { ...res.value, owner: ownerFor(pane) },
    // Opening an artifact is a request to look at it. With a terminal already
    // in the rail the tab would otherwise appear behind the one in front, and
    // the click would read as having done nothing.
    activeDockTab: PREVIEW_TAB,
  });
}

/** Which conversation a pane is showing, in the shape the dock records. */
function ownerFor(pane: Pane): DockOwner {
  const state = paneState(pane);
  const sessionId = sessionShownBy(state);
  return {
    paneId: pane.id,
    ...(state.run === null ? {} : { runId: state.run.runId }),
    ...(sessionId === null ? {} : { sessionId }),
  };
}

/**
 * Close the preview tab. Nothing to tell the main process — see `preview.ts`.
 *
 * Which tab comes forward is not decided here: dropping the preview is enough,
 * and {@link reconcileDock} settles the strip on the write. See
 * {@link AppState.visibleDockTabs} for why that is the only place it happens.
 */
export function closePreview(): void {
  if (useApp.getState().preview === null) return;
  useApp.setState({ preview: null });
}

/* -------------------------------------------------------------------------- */
/* Files                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Show a file the conversation mentioned, in the dock.
 *
 * `reference` is what `parseFileReference` made of a fragment of an answer,
 * which is to say it came from model output and is not to be trusted for
 * anything. It is resolved here rather than at the link, because the base is the
 * *conversation's* directory and this is the layer that holds one: the same
 * relative path clicked in the other column means a different file, and a
 * component reaching for `focusedPane()` to find that out would get the wrong
 * answer in a split whose other column is focused.
 *
 * Everything else follows {@link openPreview} deliberately, including the two
 * decisions that look incidental. Ownership is read *after* the await, because
 * between the click and the bytes the user may have resumed a different session
 * into this column, and stamping the view with a conversation that has already
 * gone would have `reconcileDock` close it on arrival — which looks exactly like
 * the link not working. And a failure lands in the pane's transcript rather than
 * on the error surface: a file that could not be read is a fact about the thing
 * the reader just clicked, not a fault in the app, and it belongs where they are
 * already looking.
 */
export async function openFile(
  reference: FileReference,
  pane: Pane = focusedPane(),
): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const path = resolveFilePath(reference.path, paneState(pane).cwd, useApp.getState().platform);

  const res = await call(() => bridge.files.read({ path }));
  if (!res.ok) {
    pane.transcript.note('warn', 'Could not open this file', res.error.message);
    return;
  }

  const owner = ownerFor(pane);
  const line = reference.line === undefined ? {} : { line: reference.line };

  /*
   * The same path, opened twice, is one tab.
   *
   * A link clicked again — or the same file reached from the browser and from
   * the transcript — is a request to *look at* it, not to have two of it. So an
   * open tab for this path in this conversation is re-read (the bytes may have
   * moved on) and brought forward, keeping its id so the strip does not
   * reshuffle under the click.
   *
   * Scoped by owner as well as by path, because two columns on two checkouts
   * can hold the same relative path pointing at different files.
   */
  const open = useApp
    .getState()
    .files.find((one) => one.path === path && one.owner.paneId === owner.paneId);

  const id = open?.id ?? `file${(fileCounter += 1)}`;
  const next: FileState = { ...res.value, id, owner, ...line };

  useApp.setState((s) => ({
    files: open === undefined ? [...s.files, next] : s.files.map((one) => (one === open ? next : one)),
    // Clicking a path is a request to look at it. With a terminal already in the
    // rail the tab would otherwise open behind the one in front, and the click
    // would read as having done nothing.
    activeDockTab: { kind: 'file', id },
  }));
}

/** Tab ids, monotonic for the window's life. Never reused, so a closed tab's
 *  id cannot be inherited by the next file opened into the same slot. */
let fileCounter = 0;

/**
 * Close the file tab. Nothing to tell the main process — it kept nothing.
 *
 * Which tab comes forward is not decided here, for the reason {@link closePreview}
 * gives: dropping the file is enough, and {@link reconcileDock} settles the strip
 * on the write.
 */
export function closeFile(id: string): void {
  const { files } = useApp.getState();
  if (!files.some((one) => one.id === id)) return;
  useApp.setState({ files: files.filter((one) => one.id !== id) });
}

/**
 * Shut one column's delegated tab, without touching what it was showing.
 *
 * The ✕ here means less than it does on the two tabs beside it, and deliberately
 * so. A preview's ✕ destroys a snapshot and a terminal's kills a process; this
 * one ends a *view*. Every row stays exactly where it was, every subagent keeps
 * running, every stop button keeps working through `stopTask` — the tab was
 * never what owned any of it, and a pane that arrives on its own is not one the
 * window should be able to trap the user inside.
 *
 * What is written is the ids that were on screen, which is what makes the tab
 * stay shut through the progress messages that follow. Work delegated *after*
 * this is not in that set, so the tab comes back for it in the same way it
 * arrived the first time — or, with the dock forbidden to open on its own, on
 * the next press of the header's button; see {@link toggleTasks}.
 *
 * `tasksRequested` goes with it, and that is the half that matters under the
 * setting: shutting the tab has to withdraw the permission the press granted,
 * or the next thing delegated would open a pane the user has just closed.
 */
/**
 * Open the folder browser, bring it forward, or shut it.
 *
 * `toggleTasks`'s twin, without its one guard: that refuses when nothing is
 * delegated, and a working directory always exists — so this only ever has to
 * decide between the three states of a tab.
 */
export function toggleFiles(pane: Pane = focusedPane()): void {
  const tab: DockTab = { kind: 'files', paneId: pane.id };
  if (sameTab(useApp.getState().activeDockTab, tab)) {
    closeFiles(pane.id);
    return;
  }
  if (!paneState(pane).filesRequested) setPaneState(pane, { filesRequested: true });
  focusDockTab(tab);
}

export function closeFiles(paneId: PaneId): void {
  const pane = allLivePanes().find((one) => one.id === paneId);
  if (pane === undefined) return;
  // Which tab comes forward is `reconcileDock`'s, on this write.
  setPaneState(pane, { filesRequested: false });
}

export function closeTasks(paneId: PaneId): void {
  const pane = allLivePanes().find((one) => one.id === paneId);
  if (pane === undefined) return;
  // Which tab comes forward is `reconcileDock`'s, on this write.
  setPaneState(pane, {
    dismissedTasks: paneState(pane).tasks.map((task) => task.id),
    tasksRequested: false,
  });
}

/**
 * What the header's delegated button does: open it, bring it forward, or shut it.
 *
 * The reason this exists at all is that {@link closeTasks} would otherwise be a
 * one-way door. The tab arrives on its own and cannot be opened by hand — there
 * is no tile in the transcript to click, the way there is for a preview — so
 * dismissing it once would put the rows out of reach until the agent happened to
 * delegate something else. A ✕ with no matching way back is not a control, it is
 * a trapdoor.
 *
 * Undoing the dismissal is unconditional rather than a stored "and then they
 * reopened it" flag: the record exists to keep the tab shut through the progress
 * messages that follow, and once the user has asked for it back there is nothing
 * left for it to suppress.
 *
 * `tasksRequested` is written all the same, and is not that flag. It answers a
 * different question — not "is this tab shut" but "is this tab the user's
 * doing" — and only the strip asks it, when the dock is forbidden to open on
 * its own and has to tell an arrival from a press. Without it this function
 * still runs, still clears the dismissal, and still focuses a tab that
 * `visibleTabs` then declines to draw: an enabled button that does nothing.
 *
 * Shaped as a toggle for the same reason {@link toggleTerminal} is — a button
 * that opens something and then does nothing on the second press reads as
 * broken, and this one is next to that one in the header.
 */
export function toggleTasks(pane: Pane = focusedPane()): void {
  const state = paneState(pane);
  // Nothing delegated: there is no tab for this column and nothing to put in
  // one. The button says as much and is disabled, but this cannot lean on that —
  // the palette and any future hotkey come straight here.
  if (state.tasks.length === 0) return;

  const tab: DockTab = { kind: 'tasks', paneId: pane.id };
  if (sameTab(useApp.getState().activeDockTab, tab)) {
    closeTasks(pane.id);
    return;
  }

  // Guarded so that a press which only brings an already-open tab forward
  // writes nothing: this runs on a strip that rebuilds on every progress
  // message, and a needless write here would rebuild it again.
  if (state.dismissedTasks.length > 0 || !state.tasksRequested) {
    setPaneState(pane, { dismissedTasks: [], tasksRequested: true });
  }
  focusDockTab(tab);
}

/* -------------------------------------------------------------------------- */
/* Delegated agents, opened into tabs of their own                            */
/* -------------------------------------------------------------------------- */

/**
 * How often an open agent tab asks for what its agent has said since.
 *
 * The one thing a delegated row cannot do is show the work, and the reason to
 * poll at all is that a subagent's transcript is a *file* — the provider streams
 * none of it to the parent process, so there is no event to subscribe to. Two
 * and a half seconds is the same order as the tasks pane's own clock and slow
 * enough that a long conversation is not re-read faster than a person can read
 * it; each poll asks only for messages past the ones already held.
 */
const AGENT_POLL_MS = 2_500;

/**
 * How many stored messages one poll may bring back.
 *
 * A bound rather than an unbounded read, because the first fetch on a finished
 * agent can be a very long conversation and the transcript builds it
 * synchronously. Pages continue on the next tick, which is what makes a large
 * transcript arrive progressively instead of freezing the window once.
 */
const AGENT_PAGE = 200;

/**
 * One delegated agent's conversation, held open in a tab.
 *
 * The `pane` is the load-bearing part and is not a column: it is an off-grid
 * {@link Pane} that exists solely to own a `TranscriptModel`, so the subagent's
 * events can be rendered by the *same* `Transcript` component the main
 * conversation uses — every tool card, diff and thinking fold, for free. It is
 * deliberately created with `createPane` rather than `openPane`: a watched pane
 * would be walked by `syncRunningSessions` and `describeShown`, and an agent
 * transcript is not a conversation the window is having.
 */
export interface AgentView {
  /** `${paneId}:${taskId}` — the tab's identity, and the map key. */
  readonly key: string;
  /** The column that delegated this work. */
  readonly paneId: PaneId;
  /** The provider's task id, which is also its agent id on disk. */
  readonly taskId: string;
  /** What the row called it, so the tab has a name before anything is read. */
  readonly title: string;
  readonly pane: Pane;
  /**
   * Stored messages already folded in — the cursor the next poll reads from.
   *
   * Counted in the provider's units rather than in events, because one stored
   * message becomes several events or none. See `SubagentTranscript.consumed`.
   */
  readonly consumed: number;
  /** True while a fetch is in flight, so polls cannot overlap. */
  readonly loading: boolean;
  /** Set when the last read failed; the pane shows it instead of a blank. */
  readonly error: string | null;
}

/** The tab identity for one agent view. */
function agentViewKey(paneId: PaneId, taskId: string): string {
  return `${paneId}:${taskId}`;
}

/**
 * Does this row have a conversation behind it worth opening?
 *
 * Not every delegated task is an agent. The provider files a transcript under
 * the task id for work that *is* one — a `Task`/`Agent` call — and files nothing
 * for the rest, so the question is answered from the kind rather than by opening
 * a tab and discovering it is empty.
 *
 * Two cases deliberately answer no:
 *
 *  - **A backgrounded command.** `local_bash` and its kin are a process, not a
 *    conversation. There was never a transcript to read.
 *  - **A workflow.** Measured, not assumed: a workflow's *own* task id has no
 *    transcript — its agents each write one, filed under ids of their own, in a
 *    directory named after the workflow run. Those agents are not reported as
 *    rows, so there is nothing here to hang them off yet. A workflow row stays
 *    a progress readout, which is what it already was.
 *
 * The test is `kind` **or** a known subagent type, rather than an exact match on
 * `local_agent`, so a CLI that adds another agent-shaped kind keeps working: the
 * type is only ever set for a genuine subagent.
 */
export function taskHasTranscript(task: BackgroundTask): boolean {
  return task.kind === 'local_agent' || task.subagentType !== undefined;
}

/**
 * Can this column's delegated work be opened at all?
 *
 * Answered from the **run's** capabilities rather than through
 * {@link activeCapabilities}, and the difference is the whole point: a
 * delegated task belongs to the run that launched it, and by the time anyone
 * wants to read one that run has almost always ended. `activeCapabilities`
 * falls back to the currently *selected* provider once a run is over, so a
 * finished Claude run whose selector has since been moved to another provider
 * would answer "no subagent transcripts" about transcripts that plainly exist.
 *
 * The same reasoning decides which account the read is made under — see
 * {@link refreshAgentView}, which addresses the run's own profile and session.
 */
export function canOpenSubagents(state: SessionState): boolean {
  if (state.run !== null) return state.run.capabilities.subagentTranscripts;
  return activeCapabilities(state).subagentTranscripts;
}

/**
 * Open one delegated agent's conversation in a tab of its own.
 *
 * The whole feature in one function: a row in the delegated list names a task,
 * the provider files that task's transcript under the same id, and this is what
 * turns the one into the other. Nothing correlates two identifier spaces because
 * there is only one — see `SessionsSubagentMessagesRequest`.
 *
 * Idempotent: a second click on a row whose tab is already open brings that tab
 * forward rather than opening a duplicate, which is what a person clicking a
 * list row expects. The first open seeds its pane from the delegating column, so
 * the transcript renders against the same working directory — that is what makes
 * a subagent's file paths and diffs read correctly rather than as absolutes from
 * nowhere.
 */
export function openAgentTab(paneId: PaneId, taskId: string): void {
  const key = agentViewKey(paneId, taskId);
  const existing = useApp.getState().agentViews.find((view) => view.key === key);
  if (existing !== undefined) {
    focusDockTab({ kind: 'agent', paneId, taskId });
    return;
  }

  const owner = allLivePanes().find((one) => one.id === paneId);
  if (owner === undefined) return;
  const ownerState = paneState(owner);
  const task = ownerState.tasks.find((one) => one.id === taskId);
  // Guarded here as well as in the row, because the row is not the only way in:
  // opening a tab onto work that files no transcript would produce a permanent
  // "left no transcript" pane the user cannot tell from a broken one.
  if (task !== undefined && !taskHasTranscript(task)) return;
  if (!canOpenSubagents(ownerState)) return;

  /*
   * Seeded from the delegating column, with the conversation stripped out.
   *
   * The inherited half is what makes the transcript render correctly: `cwd`
   * decides how a subagent's file paths are shortened and which of its writes
   * count as artifacts, and the mirrored catalogues are what tool cards read.
   * The cleared half is everything that would claim this pane is *having* a
   * conversation — a run to stop, a queue to answer, a list of its own
   * delegated work — none of which is true of a view onto a file.
   */
  const pane = createPane({
    ...ownerState,
    run: null,
    permissionQueue: [],
    tasks: [],
    dismissedTasks: [],
    tasksRequested: false,
    rewindToMessageId: null,
    draft: '',
    parkedDrafts: {},
  });

  useApp.setState((s) => ({
    agentViews: [
      ...s.agentViews,
      {
        key,
        paneId,
        taskId,
        title: task?.description ?? 'agent',
        pane,
        consumed: 0,
        loading: false,
        error: null,
      },
    ],
  }));

  focusDockTab({ kind: 'agent', paneId, taskId });
  void refreshAgentView(key);
}

/**
 * Close one agent tab. The agent is not touched.
 *
 * The same weak ✕ the delegated list has, for a stronger reason: this tab owns
 * nothing at all. It is a read of a file that the provider goes on writing, so
 * closing it stops a poll and releases a transcript, and the row it was opened
 * from is still there to open it again. Stopping the agent is the ⏹ on that
 * row, and remains the only thing that does.
 */
export function closeAgentTab(paneId: PaneId, taskId: string): void {
  const key = agentViewKey(paneId, taskId);
  const view = useApp.getState().agentViews.find((one) => one.key === key);
  if (view === undefined) return;
  // The transcript is the only thing here worth reclaiming, and it can be
  // large: a finished agent's conversation is routinely hundreds of messages.
  view.pane.transcript.reset();
  useApp.setState((s) => ({ agentViews: s.agentViews.filter((one) => one.key !== key) }));
}

/** Drop every agent tab belonging to a conversation that has been retired. */
function closeAgentTabsFor(paneId: PaneId): void {
  const { agentViews } = useApp.getState();
  const doomed = agentViews.filter((view) => view.paneId === paneId);
  if (doomed.length === 0) return;
  for (const view of doomed) view.pane.transcript.reset();
  useApp.setState({ agentViews: agentViews.filter((view) => view.paneId !== paneId) });
}

/** True while the task behind an open tab is still going. Drives the poll. */
export function agentViewIsLive(state: AppState, key: string): boolean {
  const view = state.agentViews.find((one) => one.key === key);
  if (view === undefined) return false;
  const owner = allLivePanes(state).find((one) => one.id === view.paneId);
  if (owner === undefined) return false;
  const task = paneState(owner).tasks.find((one) => one.id === view.taskId);
  return task !== undefined && isTaskLive(task);
}

/**
 * Read whatever the agent has written since the last read, and fold it in.
 *
 * Append-only by construction: the request starts at `consumed`, so a poll on a
 * long conversation carries the handful of messages that are new rather than
 * the whole thing again, and the transcript is never rebuilt from scratch under
 * a reader.
 *
 * Two guards worth naming. A fetch already in flight is not joined by a second
 * one — the poll fires on a timer and a slow read must not stack. And the view
 * is re-read from the store *after* the await, because the tab can be closed
 * while its page is in transit and applying events to a transcript nobody is
 * subscribed to is the cheap version of a leak.
 */
export async function refreshAgentView(key: string): Promise<void> {
  const state = useApp.getState();
  const view = state.agentViews.find((one) => one.key === key);
  if (view === undefined || view.loading) return;

  const owner = allLivePanes(state).find((one) => one.id === view.paneId);
  if (owner === undefined) return;
  const ownerState = paneState(owner);
  /*
   * The run's own account and session, not the column's current selection.
   *
   * A task belongs to the run that launched it, and both of these can move
   * afterwards — the user picks another profile, or resumes something else into
   * the column — while the transcript on disk stays exactly where that run put
   * it. Reading under the selection would look in another account's store for a
   * file that was never there.
   */
  const sessionId = ownerState.run?.sessionId ?? sessionShownBy(ownerState);
  const profileId = ownerState.run?.profileId ?? ownerState.activeProfileId;
  const cwd = ownerState.run?.cwd ?? ownerState.cwd;

  // Before the first turn has landed a session id there is no transcript to
  // read — the agent's file is filed under its parent, and the parent has no
  // name yet. The poll comes back a beat later, by which time it does.
  if (sessionId === null || profileId === null) return;

  const { bridge } = resolveBridge();
  if (!bridge) return;

  setAgentView(key, { loading: true });
  const result = await call(() =>
    bridge.sessions.subagentMessages({
      profileId,
      sessionId,
      agentId: view.taskId,
      /*
       * A synthetic run id, and it must not be the owning run's.
       *
       * Replayed pages restart their `seq` at zero, and the transcript reports
       * a sequence it cannot explain by asking the store whether that run is
       * still alive — which, for a real run id, can settle the user's live
       * conversation as though its end had been dropped. Nothing owns this id,
       * so that path finds no pane and does nothing, which is the correct
       * amount of nothing.
       */
      runId: `agent:${view.taskId}` as RunId,
      ...(cwd === null ? {} : { cwd }),
      offset: view.consumed,
      limit: AGENT_PAGE,
    }),
  );

  // Re-read: the tab may have been closed while this was in flight.
  const still = useApp.getState().agentViews.find((one) => one.key === key);
  if (still === undefined) return;

  if (!result.ok) {
    setAgentView(key, { loading: false, error: result.error.message });
    return;
  }

  for (const event of result.value.events) still.pane.transcript.apply(event);
  setAgentView(key, {
    loading: false,
    error: null,
    consumed: still.consumed + result.value.consumed,
  });

  // More is already waiting: keep paging rather than leaving the rest of a
  // finished conversation behind the next poll, which for a settled agent
  // would never come.
  if (result.value.hasMore) void refreshAgentView(key);
}

/** Patch one view in place, leaving the others' identities alone. */
function setAgentView(key: string, patch: Partial<AgentView>): void {
  useApp.setState((s) => ({
    agentViews: s.agentViews.map((view) => (view.key === key ? { ...view, ...patch } : view)),
  }));
}

/**
 * Which session a column is showing, or `null` before it has one.
 *
 * The run's own id first, the pane's `resumeSessionId` second, and both for the
 * reason `syncRunningSessions` sets out at length: the two diverge before
 * `session.started` and after a fork, and a check that consults only one of them
 * is wrong in whichever of those cases it ignores.
 */
function sessionShownBy(state: SessionState): SessionId | null {
  return state.run?.sessionId ?? state.resumeSessionId;
}

/**
 * What each visible column is currently showing, in the shape `dock.ts` wants.
 *
 * **Visible panes only, and deliberately not `allLivePanes`.** A backgrounded
 * run is one the user navigated away from; leaving its dock on screen while its
 * transcript is not is orphaning by another route.
 *
 * Memoised on the grid's identity for the reason {@link allPanes} gives, with
 * one addition: this also has to change when a *pane's own* run or session
 * changes, which the grid's identity does not capture. So the cached value is
 * compared element-wise before being reused, which is cheap — a handful of
 * string compares — and is what keeps `reconcileDock` from writing on every
 * keystroke in a composer.
 */
let shownCache: readonly ShownConversation[] = [];

/**
 * Whether this column has delegated work it should be offering a tab for.
 *
 * Which is not the same question as whether it has any: closing the tab records
 * the rows that were in it, and a column whose every row has been dismissed has
 * work but nothing left to announce. The tab comes back on the first task that
 * is not in that record — see `dismissedTasks`.
 */
function showsTasks(state: SessionState): boolean {
  if (state.tasks.length === 0) return false;
  if (state.dismissedTasks.length === 0) return true;
  return state.tasks.some((task) => !state.dismissedTasks.includes(task.id));
}

function describeShown(): readonly ShownConversation[] {
  const next = allPanes().map((pane) => {
    const state = paneState(pane);
    const sessionId = sessionShownBy(state);
    return {
      paneId: pane.id,
      ...(state.run === null ? {} : { runId: state.run.runId }),
      ...(sessionId === null ? {} : { sessionId }),
      // Whether this column has anything to put in a tasks tab. A boolean rather
      // than the rows themselves: the dock only decides whether the tab exists,
      // and carrying the set through here would make every progress message
      // rebuild the strip.
      ...(showsTasks(state) ? { hasTasks: true } : {}),
      // Reported beside it rather than folded into it, because the two are read
      // by different rules: `hasTasks` says a tab is warranted, this says who
      // warranted it. Only the second survives the dock being told never to
      // open on its own.
      ...(state.tasksRequested ? { tasksRequested: true } : {}),
      ...(state.filesRequested ? { filesRequested: true } : {}),
    };
  });

  const same =
    next.length === shownCache.length &&
    next.every((one, index) => {
      const before = shownCache[index] as ShownConversation;
      return (
        one.paneId === before.paneId &&
        one.runId === before.runId &&
        one.sessionId === before.sessionId &&
        one.hasTasks === before.hasTasks &&
        one.tasksRequested === before.tasksRequested &&
        // Every field this object carries has to be compared here. Leaving one
        // out reuses a cached array that disagrees with the panes, and the
        // strip stops tracking it — which is what closing the folder browser
        // did: the flag went false, this said "nothing moved", and the tab sat
        // there with nothing behind it.
        one.filesRequested === before.filesRequested
      );
    });

  if (!same) shownCache = next;
  return shownCache;
}

/**
 * Keep the dock honest about which conversation it belongs to.
 *
 * Three jobs, and the second is where the preview and the terminals part
 * company — see `state/dock.ts` for the argument, which is the load-bearing
 * design decision in this feature:
 *
 *  1. **Adopt session ids** that owning runs have learned since. A conversation
 *     that opened something before `session.started` is owned by its run; once
 *     there is a session id, that is the identity that survives the run ending
 *     and matches a later resume.
 *  2. **Retire what is orphaned.** A preview whose conversation has left the
 *     screen is *destroyed* — it was a snapshot, and the tile in the transcript
 *     is the way back. A terminal whose conversation has left is merely no
 *     longer drawn: the record stays, the shell keeps running, and coming back
 *     to that conversation brings the tab back with its scrollback.
 *  3. **Keep the active tab on something visible**, falling to the neighbour on
 *     the left rather than leaving the rail blank or jumping to the far end.
 *
 * Runs on every pane write and every window write, which is very often. It is
 * written to do nothing at all — no allocation past `describeShown`'s reuse, no
 * `setState` — in the overwhelmingly common case where nothing has moved.
 */
function reconcileDock(): void {
  const state = useApp.getState();
  const { preview, files, terminals, browsers, activeDockTab, visibleDockTabs, agentViews } =
    state;

  /*
   * The overwhelmingly common case: an empty dock that was already empty. This
   * runs on every keystroke in a composer, so it returns before allocating.
   *
   * Delegated work is in the condition because it is the one thing in the dock
   * that no user action puts there. A preview and a terminal are both opened by
   * something that also writes to the window store, so the strip could never
   * need rebuilding while all three of these were empty — until a column could
   * acquire tasks on its own, at which point this returned early and the tab
   * never appeared. The walk is over the open columns, of which there are at
   * most four, reading one field each.
   */
  if (
    preview === null &&
    files.length === 0 &&
    terminals.length === 0 &&
    browsers.length === 0 &&
    visibleDockTabs.length === 0 &&
    agentViews.length === 0 &&
    // Delegated work still cannot be the reason the strip needs rebuilding
    // when no column may claim a tab for it — but "may" is no longer the
    // setting alone. A column whose tab the user opened by hand claims one
    // with the setting off, and returning early on it would leave the strip
    // empty, the dock shut, and that press looking like it did nothing. The
    // condition is `visibleTabs`', which the two have to agree on exactly —
    // and the folder browser is the second tab a column can claim without
    // anything else being in the dock, so it is in here for the same reason.
    !allPanes().some((pane) => {
      const one = paneState(pane);
      if (one.filesRequested === true) return true;
      return showsTasks(one) && (state.dockAutoOpen || one.tasksRequested);
    })
  ) {
    return;
  }

  const shown = describeShown();

  const patch: {
    preview?: PreviewState | null;
    files?: readonly FileState[];
    terminals?: readonly TerminalRecord[];
    browsers?: readonly BrowserRecord[];
    activeDockTab?: DockTab | null;
    visibleDockTabs?: readonly DockTab[];
  } = {};

  let nextPreview = preview;
  if (nextPreview !== null) {
    const learned = learnSessionId(nextPreview.owner, shown);
    if (learned !== null) {
      nextPreview = { ...nextPreview, owner: { ...nextPreview.owner, sessionId: learned } };
    }
    // Destroyed, not hidden. The tile in the transcript is the way back.
    if (!ownerIsShown(nextPreview.owner, shown)) nextPreview = null;
    if (nextPreview !== preview) patch.preview = nextPreview;
  }

  // The same two moves, for the same reasons: adopt the session id once the run
  // learns it, and destroy the view when its conversation leaves the screen. The
  // path in the transcript — or in the folder browser — is the way back, exactly
  // as the tile is for a preview.
  const adoptedFiles = files.map((one) => {
    const learned = learnSessionId(one.owner, shown);
    return learned === null ? one : { ...one, owner: { ...one.owner, sessionId: learned } };
  });
  const keptFiles = adoptedFiles.filter((one) => ownerIsShown(one.owner, shown));
  const nextFiles =
    keptFiles.length === files.length && keptFiles.every((one, index) => one === files[index])
      ? files
      : keptFiles;
  if (nextFiles !== files) patch.files = nextFiles;

  // Terminals are only ever *re-owned* here, never dropped: a shell whose
  // conversation has left the screen stops being drawn and goes on running.
  const adopted = terminals.map((terminal) => {
    const learned = learnSessionId(terminal.owner, shown);
    return learned === null
      ? terminal
      : { ...terminal, owner: { ...terminal.owner, sessionId: learned } };
  });
  const nextTerminals = adopted.some((terminal, index) => terminal !== terminals[index])
    ? adopted
    : terminals;
  if (nextTerminals !== terminals) patch.terminals = nextTerminals;

  // Browsers get the terminal's treatment exactly: re-owned when the run learns
  // its session id, never dropped. A page whose conversation has left the
  // screen stops being drawn — `BrowserPane` reports `visible: false` and main
  // detaches the view — and goes on running.
  const adoptedBrowsers = browsers.map((browser) => {
    const learned = learnSessionId(browser.owner, shown);
    return learned === null
      ? browser
      : { ...browser, owner: { ...browser.owner, sessionId: learned } };
  });
  const nextBrowsers = adoptedBrowsers.some((browser, index) => browser !== browsers[index])
    ? adoptedBrowsers
    : browsers;
  if (nextBrowsers !== browsers) patch.browsers = nextBrowsers;

  const visible = visibleTabs(
    nextPreview?.owner ?? null,
    nextTerminals,
    shown,
    agentViews,
    nextFiles,
    nextBrowsers,
    state.dockAutoOpen,
  );
  const moved =
    visible.length !== visibleDockTabs.length ||
    visible.some((tab, index) => !sameTab(tab, visibleDockTabs[index] as DockTab));
  if (moved) patch.visibleDockTabs = visible;

  /*
   * `visibleDockTabs` is passed as the *previous* strip, which is what makes
   * "fall to the neighbour on the left" answerable: by the time this runs the
   * tab that went away is already gone from `visible`, and the stored value is
   * the last state in which its position was known.
   */
  const nextActive = nextActiveTab(activeDockTab, visible, visibleDockTabs);
  if (!sameTab(nextActive, activeDockTab)) patch.activeDockTab = nextActive;

  if (Object.keys(patch).length > 0) useApp.setState(patch);
}

/* -------------------------------------------------------------------------- */
/* Terminals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bring one dock tab to the front.
 *
 * Clicking a terminal's tab also asks for the caret, because that is what
 * clicking a terminal means. Only here and in {@link openTerminal} — a tab that
 * merely *reappears* when its conversation comes back must not take focus from
 * the composer; see `requestTerminalFocus`.
 */
export function focusDockTab(tab: DockTab): void {
  if (sameTab(useApp.getState().activeDockTab, tab)) return;
  useApp.setState({ activeDockTab: tab });
  if (tab.kind === 'terminal') requestTerminalFocus(tab.id);
}

/**
 * Open a shell on this conversation's working directory.
 *
 * The size passed to `start` is a **guess, and deliberately a coarse one**: the
 * rail has not been laid out yet — it may not even be mounted — so there is
 * nothing to measure. `TerminalView` fits and resizes the moment it has a box,
 * which is one frame later and before the shell has finished printing its
 * prompt. Starting at a plausible size and correcting beats blocking the open on
 * a layout pass, and beats starting at 0×0, which some shells hang on.
 *
 * A failure lands in the pane's transcript rather than on the error surface, the
 * same call {@link openPreview} makes: failing to open a terminal is a fact
 * about this conversation, and it belongs where the user is already looking.
 */
export async function openTerminal(pane: Pane = focusedPane()): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const cwd = paneState(pane).cwd;
  if (cwd.trim().length === 0) {
    pane.transcript.note('warn', 'Choose a folder first', 'A terminal needs somewhere to start.');
    return;
  }

  const res = await call(() => bridge.terminal.start({ cwd, cols: 80, rows: 24 }));
  if (!res.ok) {
    pane.transcript.note('warn', 'Could not open a terminal', res.error.message);
    return;
  }

  /*
   * Ownership is read *after* the await, exactly as `openPreview` explains: the
   * user may have resumed a different session into this column while the shell
   * was starting, and stamping the terminal with the conversation that was there
   * when the key was pressed would hand it an owner that is already gone.
   */
  const info = res.value.terminal;
  /*
   * The xterm instance is created *here*, not in `TerminalView`'s effect, and
   * the ordering is load-bearing. The shell starts printing its prompt the
   * moment `start` resolves, and those bytes arrive on the push channel within
   * a millisecond or two — well before React has mounted anything. A session
   * that did not exist yet would have them dropped by `writeToTerminal`, and
   * the tab would open onto a blank pane with a live shell behind it.
   */
  ensureTerminalSession(info.id);

  const record: TerminalRecord = {
    info,
    owner: ownerFor(pane),
    title: lastSegment(info.shell),
    exited: false,
  };

  useApp.setState((state) => ({
    terminals: [...state.terminals, record],
    activeDockTab: { kind: 'terminal', id: info.id },
  }));
  // Redeemed by `attachTerminal` once `TerminalView` has mounted, so that ⌘J
  // leaves you able to type into the shell you just asked for.
  requestTerminalFocus(info.id);
}

/**
 * The focused conversation's terminal — the existing one, or a new one.
 *
 * What `⌘J` does. Pressing it repeatedly should not fill the strip with shells
 * nobody asked for, so it opens one the first time and brings that one forward
 * afterwards; the `+` on the strip is the deliberate way to get a second.
 */
export function toggleTerminal(pane: Pane = focusedPane()): void {
  const state = useApp.getState();
  const shown = describeShown();
  const mine = state.terminals.find(
    (terminal) => terminal.owner.paneId === pane.id && ownerIsShown(terminal.owner, shown),
  );
  if (mine === undefined) {
    void openTerminal(pane);
    return;
  }

  const tab: DockTab = { kind: 'terminal', id: mine.info.id };
  // Already in front: the second press closes the rail rather than doing
  // nothing, which is what makes it a toggle and what people expect of the key
  // that opened it.
  if (sameTab(state.activeDockTab, tab)) closeTerminal(mine.info.id);
  else focusDockTab(tab);
}

/**
 * Kill a terminal and drop its tab.
 *
 * The only thing that ends a shell — see `state/dock.ts`. Everything else that
 * makes a tab disappear (switching session, closing a pane, reloading) leaves
 * the process running on purpose.
 *
 * The record is dropped immediately rather than after the main process
 * confirms. The alternative is a tab that lingers for a round trip after the
 * user clicked ✕, and there is nothing useful to do with a failure: the shell
 * is either dead or unreachable, and neither is worth keeping a tab for.
 */
export function closeTerminal(id: TerminalId): void {
  const state = useApp.getState();
  if (!state.terminals.some((terminal) => terminal.info.id === id)) return;

  // Which tab comes forward is `reconcileDock`'s, on this write.
  useApp.setState({
    terminals: state.terminals.filter((terminal) => terminal.info.id !== id),
  });

  disposeTerminalSession(id);

  const { bridge } = resolveBridge();
  if (bridge) void call(() => bridge.terminal.close({ id }));
}

/* -------------------------------------------------------------------------- */
/* Browsers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Open a page beside a conversation.
 *
 * Follows {@link openTerminal} beat for beat, including the one decision that
 * looks incidental: ownership is stamped **after** the await, because between
 * the click and the view existing the user may have resumed a different session
 * into this column, and an owner that has already gone would have
 * `reconcileDock` hide the tab the moment it appeared.
 *
 * Unlike a terminal it needs no `cwd` — a browser is not *of* anywhere — so this
 * works in a pane that has never been pointed at a folder.
 */
export async function openBrowser(pane: Pane = focusedPane(), query?: string): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const res = await call(() => bridge.browser.open(query === undefined ? {} : { query }));
  if (!res.ok) {
    pane.transcript.note('warn', 'Could not open a browser', res.error.message);
    return;
  }

  const record: BrowserRecord = { info: res.value.browser, owner: ownerFor(pane) };
  useApp.setState((state) => ({
    browsers: [...state.browsers, record],
    activeDockTab: { kind: 'browser', id: record.info.id },
  }));
}

/**
 * Go somewhere, from the address bar.
 *
 * The refusal is reported into the pane's transcript rather than thrown away,
 * because "that is not an address" is the single most likely outcome of typing
 * into this box — there is no search engine behind it, deliberately, and a user
 * who does not know that deserves to be told rather than left with a box that
 * does nothing. See `browserUrlFor`.
 */
export async function navigateBrowser(id: BrowserId, query: string): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const res = await call(() => bridge.browser.navigate({ id, query }));
  if (!res.ok) {
    const pane = paneOwning(id) ?? focusedPane();
    pane.transcript.note('warn', 'Could not open that address', res.error.message);
  }
}

/** Back, forward, reload, stop. Fire and forget; the state arrives as an event. */
export function commandBrowser(id: BrowserId, command: BrowserCommand): void {
  const { bridge } = resolveBridge();
  if (bridge) void call(() => bridge.browser.command({ id, command }));
}

/**
 * Tell main where the page goes.
 *
 * Called from `BrowserPane` on every resize frame and on every tab change, so
 * it is deliberately not a store write: nothing in the renderer depends on the
 * rectangle, and putting it in state would re-render the transcript beside it
 * sixty times a second during a drag.
 */
export function layoutBrowser(id: BrowserId, bounds: BrowserBounds, visible: boolean): void {
  const { bridge } = resolveBridge();
  if (bridge) void call(() => bridge.browser.layout({ id, bounds, visible }));
}

/**
 * Destroy a page and drop its tab.
 *
 * The only thing that ends one — see `state/dock.ts`. The record goes
 * immediately rather than after main confirms, for {@link closeTerminal}'s
 * reason: a tab that lingers for a round trip after the ✕ was clicked reads as
 * a broken button, and there is nothing useful to do with a failure.
 */
export function closeBrowser(id: BrowserId): void {
  const state = useApp.getState();
  if (!state.browsers.some((browser) => browser.info.id === id)) return;

  // Which tab comes forward is `reconcileDock`'s, on this write.
  useApp.setState({ browsers: state.browsers.filter((browser) => browser.info.id !== id) });

  const { bridge } = resolveBridge();
  if (bridge) void call(() => bridge.browser.close({ id }));
}

/**
 * The focused conversation's browser — the existing one, or a new one.
 *
 * `toggleTerminal`'s twin, and the same argument: a key that opened a second
 * page every time it was pressed would fill the strip, so it opens one and
 * brings that one forward afterwards. The `+` menu is the deliberate way to get
 * another.
 */
export function toggleBrowser(pane: Pane = focusedPane()): void {
  const state = useApp.getState();
  const shown = describeShown();
  const mine = state.browsers.find(
    (browser) => browser.owner.paneId === pane.id && ownerIsShown(browser.owner, shown),
  );
  if (mine === undefined) {
    void openBrowser(pane);
    return;
  }

  const tab: DockTab = { kind: 'browser', id: mine.info.id };
  if (sameTab(state.activeDockTab, tab)) closeBrowser(mine.info.id);
  else focusDockTab(tab);
}

/** Which pane a browser belongs to, for reporting a failure where it happened. */
function paneOwning(id: BrowserId): Pane | null {
  const owner = useApp.getState().browsers.find((browser) => browser.info.id === id)?.owner;
  return owner === undefined ? null : (allPanes().find((pane) => pane.id === owner.paneId) ?? null);
}

/**
 * Rename a tab, because the program running in it said so.
 *
 * Driven by the OSC title sequence xterm parses for us — `vim` sets it, `ssh`
 * sets it, and a well-configured shell sets it back to the directory afterwards.
 * A no-op write is dropped because this fires on nearly every prompt.
 */
export function setTerminalTitle(id: TerminalId, title: string): void {
  const trimmed = title.trim();
  if (trimmed === '') return;
  useApp.setState((state) => {
    const index = state.terminals.findIndex((terminal) => terminal.info.id === id);
    if (index < 0 || (state.terminals[index] as TerminalRecord).title === trimmed) return state;
    const terminals = [...state.terminals];
    terminals[index] = { ...(terminals[index] as TerminalRecord), title: trimmed };
    return { ...state, terminals };
  });
}

/**
 * Note that a shell has ended, without closing its tab.
 *
 * The tab stays so that whatever the shell said on its way out — a stack trace,
 * a `command not found`, an `exit 1` — is still readable. It is marked so the
 * strip can grey it, and closing it is left to the user, who is the one who
 * knows whether they have finished reading.
 */
export function markTerminalExited(id: TerminalId): void {
  useApp.setState((state) => {
    const index = state.terminals.findIndex((terminal) => terminal.info.id === id);
    if (index < 0 || (state.terminals[index] as TerminalRecord).exited) return state;
    const terminals = [...state.terminals];
    const record = terminals[index] as TerminalRecord;
    terminals[index] = { ...record, exited: true, info: { ...record.info, exited: true } };
    return { ...state, terminals };
  });
}

/**
 * Artifacts already opened by themselves, by conversation.
 *
 * Auto-open fires **once per conversation**, and this is the memory that makes
 * "once" true across the events that would otherwise reset it. Keyed by session
 * id where there is one and by run id before there is, mirroring
 * {@link PreviewOwner} for the same reasons.
 *
 * Deliberately not cleared when a preview is closed. Closing the pane is the
 * user saying they are done looking; reopening it on the next write would be
 * the app overruling them, and the tile is right there. A conversation gets one
 * uninvited pane, ever.
 */
const autoOpened = new Set<string>();

/**
 * Open the pane for an artifact the agent just wrote, if this is the moment for
 * it.
 *
 * Four conditions, and each one is a way this would otherwise be rude:
 *
 *  1. **Only a fresh artifact**, never an edit — unless the edit is to the page
 *     already on screen, which is a refresh rather than an interruption. This is
 *     what stops a session of "make it blue, now bigger" from flapping.
 *  2. **Only the focused column.** A background column's write must not take the
 *     window; the user is reading something else.
 *  3. **Only once per conversation.** See {@link autoOpened}.
 *  4. **Never over an open preview** the user is already reading, unless it is
 *     the same file.
 */
function maybeAutoOpen(pane: Pane, artifact: Artifact): void {
  const state = useApp.getState();
  const showing = state.preview;
  const sameFile = showing !== null && showing.path === artifact.path;

  // A revision of what is already framed refreshes it, whatever else is true:
  // the user is looking at this exact file and it just changed underneath them.
  if (sameFile) {
    void openPreview(artifact.path, pane);
    return;
  }

  // The user has said the dock never opens on its own. Above this line rather
  // than first, deliberately: refreshing the file already on screen is not an
  // opening, and suppressing it would leave the reader looking at a stale page
  // the transcript says was just rewritten.
  if (!state.dockAutoOpen) return;

  if (!artifact.fresh) return;
  if (pane.id !== state.focusedPaneId) return;
  if (showing !== null) return;

  const paneNow = paneState(pane);
  const key = sessionShownBy(paneNow) ?? paneNow.run?.runId;
  if (key === undefined) return;
  if (autoOpened.has(key)) return;
  autoOpened.add(key);

  void openPreview(artifact.path, pane);
}

/**
 * Add a pane beside or below an existing one.
 *
 * ## Right grows a row; down adds a full-width one
 *
 * That asymmetry is the layout model, not a shortcut — see `PaneRow`. Splitting
 * a left/right pair downwards puts the third pane across the bottom rather than
 * quartering the window, because the user asked for a third conversation, not
 * for an empty fourth cell to keep the shape rectangular. Splitting *that* pane
 * rightwards then gives the two-by-two.
 *
 * ## The seed matters
 *
 * A new pane starting from the persisted preferences would open in whatever
 * directory the app launched in, which is almost never where the user is now —
 * splitting is something you do *while working*, to put two views of one
 * problem side by side. So it inherits the source pane's account, directory and
 * model, and starts a blank session there.
 *
 * Returns `null` when the grid is already at its limit in that direction. The
 * controls ask {@link canSplit} first and render the reason, so a `null` here is
 * the backstop for a keyboard shortcut rather than a state the UI can reach.
 */
/**
 * A blank conversation carrying over everything but the conversation.
 *
 * Shared by {@link splitPane} and {@link newSession}, which want the same thing
 * for the same reason: the account, directory, model and mode are the user's
 * current *setup*, and a fresh session is a change of subject, not a change of
 * desk. Only what a transcript is about — the run, the session id, the prompt
 * history — is left behind.
 */
function seedBeside(source: Pane, state: AppState = useApp.getState()): SessionState {
  const from = paneState(source);
  return seedSession({
    providers: state.providers,
    profiles: state.profiles,
    sessions: state.sessions,
    contextWindows: state.contextWindows,
    quickModelIdsByProfile: state.quickModelIdsByProfile,
    activeProviderId: from.activeProviderId,
    activeProfileId: from.activeProfileId,
    cwd: from.cwd,
    workspace: from.workspace,
    permissionMode: from.permissionMode,
    model: from.model,
    effort: from.effort,
    fastMode: from.fastMode,
    ultracode: from.ultracode,
    // The catalogue is a property of the account, and the account came across
    // with it — so it comes too, rather than making the new pane flash the
    // built-in list until its own fetch lands.
    models: from.models,
  });
}

export function splitPane(
  direction: SplitDirection,
  from: Pane = focusedPane(),
): Pane | null {
  const state = useApp.getState();
  const at = locate(state.grid, from.id);
  if (!at || !canSplit(state)) return null;

  const pane = openPane(seedBeside(from, state));

  useApp.setState((s) => {
    const grid = [...s.grid];
    if (direction === 'down') {
      grid.splice(at.row + 1, 0, createRow([pane]));
    } else {
      const row = grid[at.row] as PaneRow;
      const panes = [...row.panes];
      panes.splice(at.column + 1, 0, pane);
      grid[at.row] = { ...row, panes };
    }
    return { grid, focusedPaneId: pane.id };
  });

  void refreshModels(pane);
  return pane;
}

/* -------------------------------------------------------------------------- */
/* Handing a column between conversations                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many finished conversations stay in memory after the user leaves them.
 *
 * A conversation is backgrounded because it is *working*; once it ends, the
 * provider has written it to disk and reopening it from the sidebar is a
 * full-fidelity read. The only thing the in-memory copy still has that the file
 * does not is Artemis's own end-of-run card — the accounting, and, when a run
 * failed, the reason. That is worth keeping for the handful of conversations a
 * user might come back to, and not worth keeping for a day's worth.
 */
const MAX_BACKGROUND_ENDED = 8;

/**
 * Release a conversation nothing will look at again.
 *
 * Unsubscribing matters more than the transcript reset: the watcher installed by
 * {@link openPane} is a reference from a module-level map into the pane, so a
 * pane that is dropped without this is never collected — along with every
 * message in its transcript.
 */
function retirePane(pane: Pane): void {
  unwatchPane(pane.id);
  pane.transcript.reset();
  // The agent tabs opened from this conversation go with it. They are views
  // onto its delegated work, and `openAgentTab` resolves their owner through
  // the live panes — so one left behind could never be refreshed again, and
  // would sit in the strip showing a transcript frozen at whatever it last read.
  closeAgentTabsFor(pane.id);
  // Any catalogue fetch still in flight for it has nowhere to land. Dropping the
  // token both releases the entry and makes the reply's own staleness check
  // fail, which is what stops it writing into a store nothing is subscribed to.
  modelsRequestToken.delete(pane.id);
}

/** Evict finished conversations past {@link MAX_BACKGROUND_ENDED}, oldest first. */
function pruneBackground(): void {
  const { background } = useApp.getState();
  /*
   * `isWorking`, not `hasLiveWork`: a pane whose run ended but whose workflow
   * has not is not "finished" — evicting it would orphan the settle turn — and
   * between turns this window's rows are the wrong place to ask. This is the
   * last path that still destroys a conversation, so it asks both sides.
   *
   * Read once and threaded through, rather than per pane: the set is a window
   * value, the walk is over at most a handful of panes, and re-reading the store
   * inside a filter would be a store read per element for an answer that cannot
   * change during the loop.
   */
  const holding = useApp.getState().sessionsHoldingWork;
  const ended = background.filter((pane) => !isWorking(paneState(pane), holding));
  if (ended.length <= MAX_BACKGROUND_ENDED) return;

  const evicted = new Set(ended.slice(0, ended.length - MAX_BACKGROUND_ENDED).map((p) => p.id));
  for (const pane of background) if (evicted.has(pane.id)) retirePane(pane);
  useApp.setState({ background: background.filter((pane) => !evicted.has(pane.id)) });
}

/**
 * Point a column at another conversation, and let the draft stay with the one
 * it was written to.
 *
 * Called by {@link newSession} and {@link resumeSession}, and by nothing else,
 * because those are the only two places a *pane* changes conversation without
 * the column itself changing hands. When a whole pane is swapped instead (see
 * {@link handOver}) there is nothing to do here: each pane carries its own.
 *
 * Reads `resumeSessionId` as the conversation being left, so it has to run
 * *before* the patch that moves it. An empty draft parks nothing and clears
 * nothing — there is no difference between "typed nothing" and "was never
 * here", and keeping the entry would only grow the map.
 */
function swapDraft(pane: Pane, to: string): void {
  setPaneState(pane, (s) => {
    const from = s.resumeSessionId ?? UNSTARTED_DRAFT;
    if (from === to) return {};

    const parked = { ...s.parkedDrafts };
    if (s.draft.trim().length === 0) delete parked[from];
    else parked[from] = s.draft;

    const draft = parked[to] ?? '';
    delete parked[to];
    return { draft, parkedDrafts: parked };
  });
}

/**
 * Give one conversation's column to another. The outgoing one keeps running.
 *
 * This is the single move behind every "leave this session" action — ⌘N,
 * opening something from the sidebar, closing a column. Its whole point is what
 * it does *not* do: it never disposes the run. A run belongs to the main
 * process and the agent carries on working whether or not anyone is watching, so
 * the pane is moved to {@link AppState.background} and handed back intact if the
 * user returns to it. Only {@link interruptRun} and quitting stop an agent.
 *
 * `incoming` may itself be a backgrounded conversation coming home, which is why
 * the grid write and the background write happen in one `setState`: for a frame
 * in between, a pane would otherwise be in both places or in neither, and the
 * event router would deliver its stream twice or not at all.
 *
 * A conversation with nothing in flight is retired instead of backgrounded —
 * there is nothing to come back to, and its transcript is on disk.
 */
function handOver(outgoing: Pane, incoming: Pane): void {
  const state = useApp.getState();
  const at = locate(state.grid, outgoing.id);
  if (!at) return;

  // `isDisposable`, not `hasLiveWork`: this decides whether the conversation is
  // destroyed, and this window cannot see far enough to make that call. See
  // `isDisposable`.
  const keep = !isDisposable(paneState(outgoing));
  const grid = state.grid.map((row, index) =>
    index === at.row
      ? { ...row, panes: row.panes.map((p) => (p.id === outgoing.id ? incoming : p)) }
      : row,
  );
  const background = state.background.filter((p) => p.id !== incoming.id);
  if (keep) background.push(outgoing);

  useApp.setState({
    grid,
    background,
    ...(state.focusedPaneId === outgoing.id ? { focusedPaneId: incoming.id } : {}),
  });

  /*
   * A blank column is thrown away; what was typed into it is not.
   *
   * `isDisposable` is true of exactly the pane ⌘N leaves behind — no run, no
   * session — which is also the pane most likely to be holding an unsent
   * sentence, because it has no conversation of its own to have sent it to. It
   * goes to `retirePane` a line below and takes its state with it, so the one
   * thing worth rescuing moves across first: the next new session in this
   * column finds the prompt where it was left. Only into an empty slot, so a
   * pane coming home with its own half-written prompt keeps it.
   */
  if (!keep) {
    const orphan = paneState(outgoing).draft;
    if (orphan.trim().length > 0) {
      setPaneState(incoming, (s) =>
        (s.parkedDrafts[UNSTARTED_DRAFT] ?? '').length > 0
          ? {}
          : { parkedDrafts: { ...s.parkedDrafts, [UNSTARTED_DRAFT]: orphan } },
      );
    }
    retirePane(outgoing);
  }

  pruneBackground();
  savePrefs();
}

/**
 * Move a working conversation out of its column and put a blank one there.
 *
 * Returns the pane now holding the column, which every caller must use from that
 * point on: the pane they were handed is still alive, but it is no longer the
 * one on screen.
 */
function handOffToBlank(pane: Pane): Pane {
  const fresh = openPane(seedBeside(pane));

  /*
   * The one draft that belongs to the column rather than to a conversation.
   *
   * Every *started* conversation's half-written prompt travels with it — parked
   * under its session id, handed back when the user returns to it. The
   * unstarted one has no conversation to travel with: it is what was typed into
   * this column's blank session, and the blank session this returns is the same
   * blank session as far as anyone using it is concerned. So it comes across,
   * and it leaves the pane it came from, because a draft in two columns at once
   * is a prompt that can be sent twice.
   */
  const carried = paneState(pane).parkedDrafts[UNSTARTED_DRAFT];
  if (carried !== undefined && carried.length > 0) {
    setPaneState(fresh, { draft: carried });
    setPaneState(pane, (s) => {
      const parked = { ...s.parkedDrafts };
      delete parked[UNSTARTED_DRAFT];
      return { parkedDrafts: parked };
    });
  }

  handOver(pane, fresh);
  return fresh;
}

/**
 * Close a pane. Whatever it was running carries on without it.
 *
 * Refuses to close the last one: a window with no conversation in it has no way
 * back to having one, and "close" would read as "quit". With a single pane open
 * the control is not rendered at all, so this is the guard for the palette and
 * the hotkey rather than a state the UI can reach.
 *
 * A row that loses its last pane goes with it, which is what makes the grid
 * collapse the way people expect: closing the lone pane on the bottom row gives
 * the width back to the row above rather than leaving a band of nothing.
 *
 * Focus moves to the nearest surviving neighbour — the pane that took the
 * closed one's place, or the one before it — rather than jumping to the top
 * left. In a full grid, having the focus leap across the window because
 * you closed something in the corner is disorienting, and the focused pane is
 * what every window-level surface is pointed at.
 *
 * A live run is backgrounded rather than disposed. Closing a column is a
 * statement about the layout, not about the work: the agent is mid-edit, the
 * sidebar goes on marking its session as running, and clicking that row brings
 * the conversation back with its transcript. Stopping an agent is what
 * {@link interruptRun} is for, and it is the only thing that does it.
 */
export function closePane(paneId: PaneId): void {
  const state = useApp.getState();
  if (paneCount(state) <= 1) return;
  const at = locate(state.grid, paneId);
  if (!at) return;
  const pane = (state.grid[at.row] as PaneRow).panes[at.column] as Pane;

  // Same rule as `handOver`, and for the same reason: closing a column is a
  // statement about the layout, so it must not be the thing that destroys a
  // conversation this window only *believes* has finished.
  const keep = !isDisposable(paneState(pane));
  if (!keep) retirePane(pane);

  const grid: PaneRow[] = [];
  for (let i = 0; i < state.grid.length; i += 1) {
    const row = state.grid[i] as PaneRow;
    if (i !== at.row) {
      grid.push(row);
      continue;
    }
    const panes = row.panes.filter((p) => p.id !== paneId);
    if (panes.length > 0) grid.push({ ...row, panes });
  }

  const survivors = grid.flatMap((row) => row.panes);
  const neighbour =
    (grid[at.row] as PaneRow | undefined)?.panes[at.column] ??
    (grid[at.row] as PaneRow | undefined)?.panes[at.column - 1] ??
    survivors[survivors.length - 1];

  useApp.setState({
    grid,
    ...(keep ? { background: [...state.background, pane] } : {}),
    ...(state.focusedPaneId === paneId ? { focusedPaneId: (neighbour as Pane).id } : {}),
  });
  pruneBackground();
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

/** The descriptor for the provider the UI is currently pointed at. */
export function activeProvider(state: SessionState): ProviderDescriptor | undefined {
  return state.providers.find((p) => p.id === state.activeProviderId);
}

/**
 * Capabilities the UI should degrade against.
 *
 * A live run keeps the capabilities it was started with, so switching the
 * provider selector mid-run cannot retroactively change what the run can do.
 */
export function activeCapabilities(state: SessionState): Capabilities {
  if (state.run && state.run.status !== 'ended') return state.run.capabilities;
  return activeProvider(state)?.capabilities ?? NO_CAPABILITIES;
}

/** Human name for the provider being degraded against, for tooltips. */
export function activeProviderLabel(state: SessionState): string {
  return activeProvider(state)?.label ?? state.activeProviderId;
}

/** True when a run is accepting events. */
export function isLive(state: SessionState): boolean {
  return state.run !== null && state.run.status !== 'ended';
}

/**
 * True while leaving this conversation would walk away from something running.
 *
 * A strictly wider question than {@link isLive}, and the difference is
 * delegated work: the `Agent` tool backgrounds by default and `Workflow` is
 * always async, so subagents routinely outlive the run that launched them by
 * minutes. Every "is this conversation worth keeping around" decision —
 * backgrounding on navigation, eviction from the background set, the sidebar's
 * working marker — has to ask this one rather than `isLive`, because a pane
 * retired on "the run ended" takes its task rows with it, and with them the
 * only place the settle turn could land: the continuation run that reports the
 * work finished is claimed by the pane holding its session, and a session
 * nobody holds is dropped. Retiring on run-end made an ultracode workflow
 * vanish from every surface the moment the user looked at anything else.
 *
 * The rows settle through the same `background.tasks` event a natural finish
 * arrives on, so this goes false on its own — nothing has to remember to
 * clean up.
 */
export function hasLiveWork(state: SessionState): boolean {
  return isLive(state) || state.tasks.some(isTaskLive);
}

/**
 * Both ids a conversation can be known by, for matching against a session set.
 *
 * The pair {@link syncRunningSessions} already explains at length: they are
 * usually the same, and they diverge before `session.started` lands and after a
 * fork. Matching on either is what stops a conversation being missed under
 * whichever id the other side happened to use.
 */
function sessionIdsOf(state: SessionState): readonly SessionId[] {
  const ids: SessionId[] = [];
  if (state.run?.sessionId) ids.push(state.run.sessionId);
  if (state.resumeSessionId && state.resumeSessionId !== state.run?.sessionId) {
    ids.push(state.resumeSessionId);
  }
  return ids;
}

/**
 * True when the main process says this conversation is still working.
 *
 * The half of the answer this window cannot see for itself — see
 * {@link AppState.sessionsHoldingWork}. Kept separate from {@link hasLiveWork}
 * rather than folded into it so that one stays a pure function of a pane, which
 * is what its callers in tests rely on.
 */
function mainHoldsWork(
  state: SessionState,
  holding: readonly SessionId[] = useApp.getState().sessionsHoldingWork,
): boolean {
  if (holding.length === 0) return false;
  return sessionIdsOf(state).some((id) => holding.includes(id));
}

/**
 * Is anything about this conversation still going — by either account?
 *
 * The union of what this window can see ({@link hasLiveWork}) and what the main
 * process reports ({@link mainHoldsWork}), and a union rather than a preference
 * because the two are authoritative about different intervals. This window is
 * right *during* a turn, where it has the rows as they arrive and main's poll is
 * up to a few seconds stale. Main is right *between* turns, where the rows have
 * stopped being sent and this window's copy is frozen. Neither dominates, and
 * either saying "working" is enough.
 *
 * This is what every question about whether a conversation is finished should
 * ask. `hasLiveWork` remains for the one thing it is exactly right about: what
 * this window has been told.
 */
export function isWorking(
  state: SessionState,
  holding?: readonly SessionId[],
): boolean {
  return hasLiveWork(state) || mainHoldsWork(state, holding);
}

/**
 * True when a conversation can be destroyed outright rather than set aside.
 *
 * Deliberately **not** the negation of {@link hasLiveWork}, and the difference
 * is what this answers for. `hasLiveWork` asks "is something running", from this
 * window's own bookkeeping, and it is the right question for everything whose
 * worst outcome is a wrong pixel: the sidebar's working marker, which dock tab
 * comes forward, how fast the session feed polls. Destruction is not one of
 * those. {@link retirePane} resets the transcript and closes every agent tab the
 * conversation opened, and nothing can reach a pane that is gone —
 * `openAgentTab` resolves its owner through `allLivePanes`, and the delegated
 * button is disabled with no rows to show. There is no way back.
 *
 * ## Why this window's answer is not good enough to destroy on
 *
 * `tasks` holds whatever the last `background.tasks` event said, and that event
 * is run-scoped: the adapter refuses to emit one once the turn has ended (see
 * `#flushTasks`), while the very same process is kept alive by `#holdsWork` for
 * exactly the work those rows describe. Between a turn ending and the next one
 * opening there is nowhere to put an update, so this window's rows are a
 * snapshot of the last moment a turn was open and the main process is the only
 * thing that knows what has happened since. A workflow that settled a row and
 * carried on reads here as finished.
 *
 * Retiring on that snapshot is the defect this exists to close: clicking away
 * from a running workflow and back left the bow at rest, the workflow tab shut,
 * and the button that reopens it disabled — while the run went on untouched in
 * main, which is why sending a message brought it all back.
 *
 * So the rule is inverted. A conversation is destroyed only when there was never
 * anything in it to lose; anything that has run, or names a session it could
 * resume, is set aside instead. Backgrounding is cheap and already bounded by
 * {@link pruneBackground}, and being wrong in this direction costs a retained
 * transcript rather than work the user cannot get back to.
 */
function isDisposable(state: SessionState): boolean {
  // Belt and braces. A conversation main is still working on necessarily has a
  // session id, so the check below already keeps it — but this is the one
  // predicate whose wrong answer is unrecoverable, and saying so explicitly
  // means a later narrowing of the rule cannot quietly take the guard with it.
  if (mainHoldsWork(state)) return false;
  return state.run === null && state.resumeSessionId === null;
}

export function activeProfile(state: SessionState): ProfileMetadata | undefined {
  return state.profiles.find((p) => p.id === state.activeProfileId);
}

/**
 * What is running right now, gathered per account.
 *
 * Over `allLivePanes` rather than `allPanes`, and that is the load-bearing
 * choice: a backgrounded conversation is consuming its account's window exactly
 * as hard as a visible one, and counting only the columns on screen would leave
 * the recommender blind to work the user deliberately walked away from — which
 * is most of it, for anyone running several sessions at once.
 *
 * Billed to `run.profileId` rather than the pane's current `activeProfileId`,
 * because a run belongs to the account it *started* on for its whole life.
 *
 * The model comes off the run where the provider has reported one and falls back
 * to what the pane asked for, since the two can differ — a provider may
 * substitute — and the run's own answer is the one actually being billed. Effort
 * and ultracode are the pane's: they are properties of the request rather than
 * facts the run reports back.
 */
function liveRunsByProfile(state: AppState = useApp.getState()): Map<ProfileId, LiveRunLoad[]> {
  const byProfile = new Map<ProfileId, LiveRunLoad[]>();
  for (const pane of allLivePanes(state)) {
    const s = paneState(pane);
    if (!isLive(s) || s.run === null) continue;
    const load: LiveRunLoad = {
      model: s.run.model ?? s.model,
      effort: s.effort,
      ultracode: s.ultracode,
    };
    const existing = byProfile.get(s.run.profileId);
    if (existing === undefined) byProfile.set(s.run.profileId, [load]);
    else existing.push(load);
  }
  return byProfile;
}

/**
 * Which account the next session should start on.
 *
 * Was "which account has the most plan capacity left, from the polled
 * readings", and the change of wording is the change of behaviour: the polled
 * reading alone answered a *different* question from the one being asked, and
 * answering it put every session started inside one poll cycle onto the same
 * account. What the ranking now weighs is headroom **less what the runs already
 * on that account are committed to spending** — see `planLoad.ts`.
 *
 * **Not a `useApp` selector**, deliberately — `recommendProfile` returns a
 * fresh object every call, and a selector whose result is never identical to
 * its predecessor re-renders on every store read until React gives up (see
 * `NO_OPTIONS` above for the same trap). Components subscribe to the two
 * *stable* inputs and call this inside a `useMemo`.
 *
 * **It reads the pane grid**, via {@link liveRunsByProfile}, and so is not a
 * pure function of its arguments. That is a real constraint on callers rather
 * than an oversight: the answer must be computed at the moment it is acted on,
 * because a run that started a second ago changes it. Both callers already do —
 * `newSession` computes it as the session is created, and the profile menu's
 * content is mounted fresh by Radix on every open, which is what re-runs its
 * `useMemo`. A cached recommendation held across either would be exactly the
 * stale answer this change exists to stop.
 *
 * `now` is a parameter rather than read here so the caller decides when
 * staleness is re-judged — the profile menu computes it as the menu opens,
 * which is exactly when the answer is about to be acted on.
 *
 * Profiles are passed in list order, which is what breaks ties: see
 * `recommendProfile`.
 *
 * Accounts the user has taken out of the pool are dropped *before* the ranking
 * rather than filtered out of its answer, and the difference is `candidates`:
 * ranking six accounts and then discarding the winner would leave the runner-up
 * described as the best of six when it was the best of the two that were
 * eligible. It also means the two-candidate rule counts the right accounts — a
 * "Recommended" heading over the only account in the pool repeats the row below
 * it, which is the case `recommendProfile` refuses.
 */
export function planRecommendation(
  profiles: readonly ProfileMetadata[],
  usageByProfile: Readonly<Record<ProfileId, PlanUsage>>,
  now: number,
): PlanRecommendation | null {
  // Read once for the whole ranking rather than per profile, so a window with
  // six open conversations walks its panes once instead of once per account.
  const running = liveRunsByProfile();

  return recommendProfile(
    profiles.filter(isProfileAutoSelectable).map((profile) => {
      const usage = usageByProfile[profile.id];
      /*
        Two sources for the plan, and the order matters. The profile's pin wins
        because it is the only one that can tell Max 5x from Max 20x — the
        provider reports the family, not the tier. Without a pin this resolves
        to the family's floor and is marked assumed; see `resolvePlanWeight`.
      */
      const capacity = resolvePlanWeight({
        providerId: profile.providerId,
        subscriptionType: usage?.subscriptionType,
        pinned: profile.planId,
      });
      return {
        profileId: profile.id,
        usage,
        providerId: profile.providerId,
        capacity,
        /*
          What this account has already been committed to, which its polled
          reading cannot yet show. Without it the ranking hands every session
          started inside one poll cycle to the same account — see
          `planLoad.ts`, which is the whole reason this argument exists.
        */
        ...(running.has(profile.id) ? { liveRuns: running.get(profile.id) } : {}),
      };
    }),
    { now },
  );
}

/**
 * The fallback for an absent list on a descriptor.
 *
 * A module constant, not a `?? []` at each call site, and this is not a
 * micro-optimisation. Selectors below are read through `useApp(selector)`,
 * which compares the result by identity to decide whether to re-render; a fresh
 * array literal is never identical to the last one, so every such selector
 * would report a change on every store read and React would loop until it hit
 * its update-depth ceiling. One frozen array keeps the identity stable.
 */
const NO_OPTIONS: readonly never[] = Object.freeze([]);

/**
 * Models the active provider offers.
 *
 * Prefers the live catalogue the account actually reported and falls back to
 * the descriptor's built-in list. That order is the point of the whole
 * catalogue path: the built-in list is a hand-maintained guess that goes stale
 * the moment the provider ships a model, so it is the *fallback*, never the
 * answer when a better one exists.
 *
 * The emptiness check is on `state.models` rather than a `live` flag because a
 * fetch that succeeded and returned nothing is indistinguishable from one that
 * never happened, and in both cases the descriptor is the better list to show.
 *
 * Empty after both means "no model choice", which the picker renders as a
 * disabled segment with that as its reason rather than as an empty menu — the
 * same rule every other capability-driven control follows.
 */
export function activeModels(state: SessionState): readonly ProviderModelOption[] {
  if (state.models.length > 0) return state.models;
  return activeProvider(state)?.models ?? NO_OPTIONS;
}

/**
 * Cache a constructed selector value on its inputs — with one slot per pane.
 * ============================================================================
 *
 * Every selector below that *builds* a value has to be memoised on its inputs,
 * for the reason the {@link NO_OPTIONS} note gives: it is read through a zustand
 * hook, which decides whether to re-render by comparing the result to the last
 * one by identity, so a fresh array on every read is an unbounded render loop.
 *
 * A single cached result is enough for a selector over the *window* — there is
 * one grid, so `allPanes` above can hold one entry and always hit. It is not
 * enough for a selector over a *pane*. These take `SessionState`, and a split
 * window has up to {@link MAX_PANES} of those, each with its own catalogue:
 * `refreshModels` is per pane by design, so two columns signed in as two
 * accounts hold two distinct `models` arrays even when the accounts offer the
 * same models.
 *
 * With one slot and several panes, the columns evict each other. Pane A reads and
 * caches; pane B reads, misses, and takes the slot; pane A's next read misses
 * against B's entry and builds a fresh array — so A's value changes identity
 * without A's state changing at all. React re-renders A, which evicts B, which
 * re-renders B, which evicts A. That is the "Maximum update depth exceeded"
 * that blanks the window once a second conversation is open, and it is why the
 * bound here is the pane limit rather than one.
 *
 * Entries are promoted on a hit, so the resident set is the panes actually on
 * screen rather than the first {@link MAX_PANES} tuples ever seen. Each pane
 * contributes exactly one live tuple at a time, so the live set always fits and
 * a pane that changes model merely pushes its own stale entry out.
 */
function memoisePerPane<I extends readonly unknown[], O>(
  compute: (...inputs: I) => O,
): (...inputs: I) => O {
  const entries: { readonly inputs: I; readonly out: O }[] = [];

  return (...inputs: I): O => {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i] as { readonly inputs: I; readonly out: O };
      if (!entry.inputs.every((value, n) => value === inputs[n])) continue;
      if (i > 0) {
        entries.splice(i, 1);
        entries.unshift(entry);
      }
      return entry.out;
    }

    const out = compute(...inputs);
    entries.unshift({ inputs, out });
    if (entries.length > MAX_PANES) entries.length = MAX_PANES;
    return out;
  };
}

/**
 * The catalogue narrowed to the user's pinned models, in catalogue order.
 *
 * Memoised on the identity of its two inputs, and that is not an optimisation:
 * a `filter` returns a fresh array every call, so an unmemoised version would
 * report a change on every store read and React would loop until it hit its
 * update-depth ceiling. Same hazard the {@link NO_OPTIONS} note describes, one
 * level up. Per pane, for the reason {@link memoisePerPane} gives.
 */
const computeQuickModels = memoisePerPane(
  (
    catalogue: readonly ProviderModelOption[],
    ids: readonly string[],
  ): readonly ProviderModelOption[] => {
    // No picks means "not curated", not "picked nothing" — a user who has never
    // opened settings still needs a usable picker, so the whole catalogue stands
    // in. Filtering to nothing would leave the status line with a menu that opens
    // onto an empty list and no way to fix it from there.
    const next = ids.length === 0 ? catalogue : catalogue.filter((m) => ids.includes(m.id));

    // A pinned set that matches nothing in the current catalogue (the ids came
    // from another provider, or the models were withdrawn) falls back the same
    // way an uncurated one does, for the same reason.
    return next.length === 0 ? catalogue : next;
  },
);

/**
 * The pins that apply to *this* pane — its profile's entry, or none.
 *
 * A pane with no profile has no entry and gets the uncurated whole catalogue,
 * which is the same answer an unpinned profile gets and for the same reason:
 * a picker that shows nothing is broken, and there is no way to express an
 * intentionally empty shortlist.
 *
 * `NO_PINS` is a module constant rather than a fresh `[]` so the identity is
 * stable across reads — `computeQuickModels` memoises on it, and a new array
 * per call would defeat the memo on every store read. Same hazard the
 * `NO_OPTIONS` note describes.
 */
export function paneQuickModelIds(state: SessionState): readonly string[] {
  const profileId = state.activeProfileId;
  if (profileId === null) return NO_PINS;
  return state.quickModelIdsByProfile[profileId] ?? NO_PINS;
}

const NO_PINS: readonly string[] = [];

export function quickModels(state: SessionState): readonly ProviderModelOption[] {
  return computeQuickModels(activeModels(state), paneQuickModelIds(state));
}

/**
 * The catalogue entry for the selected model, or `undefined` for "provider
 * default".
 *
 * A second name for {@link activeModel}, kept because the two are asked
 * different questions: `activeModel` is "what will the next run use", this is
 * "what is the settings UI describing". They resolve identically today and are
 * expected to stay that way; the alias exists so a caller reading model
 * *properties* does not read as if it were about to start a run.
 */
export function selectedModelOption(state: SessionState): ProviderModelOption | undefined {
  return activeModel(state);
}

/**
 * Whether the fast-mode toggle should be offered at all.
 *
 * False when no model is explicitly selected, and that is deliberate rather
 * than conservative-by-accident: with the provider default in force Artemis does
 * not know which model will run, so it cannot know whether the flag would be
 * honoured. An enabled toggle that the run silently ignores is worse than a
 * disabled one with a reason attached — the user believes it took effect.
 */
export function fastModeAvailable(state: SessionState): boolean {
  return selectedModelOption(state)?.supportsFastMode === true;
}

/** The same question for ultracode. Separate flag, separate answer. */
export function ultracodeAvailable(state: SessionState): boolean {
  return selectedModelOption(state)?.supportsUltracode === true;
}

/**
 * Does this provider have the *concept* of fast mode at all?
 *
 * A different question from {@link fastModeAvailable}, and the difference is
 * what decides between hiding a control and disabling it.
 *
 * `fastModeAvailable` is about the selected model, and a false answer there is
 * **actionable**: another model on the same ladder does offer it, so the control
 * stays on screen, disabled, and switching models lights it up. This one is
 * about the whole catalogue. A false answer here means no model this provider
 * offers has ever heard of the flag — Codex has no fast mode and no ultracode —
 * so there is nothing to switch to and the control can never light up. A
 * permanently dead switch teaches the user nothing except that part of the app
 * is broken, so it is not rendered.
 *
 * That is the one carve-out from this app's hide-nothing rule, and it is narrow
 * on purpose: hidden when the *provider* cannot, disabled-and-explained when the
 * *model* cannot.
 */
export function providerOffersFastMode(state: SessionState): boolean {
  return activeModels(state).some((m) => m.supportsFastMode === true);
}

/** The same question for ultracode. See {@link providerOffersFastMode}. */
export function providerOffersUltracode(state: SessionState): boolean {
  return activeModels(state).some((m) => m.supportsUltracode === true);
}

/** Reasoning-effort levels the active provider offers, least to most. */
export function activeEffortLevels(state: SessionState): readonly ProviderEffortOption[] {
  return activeProvider(state)?.effortLevels ?? NO_OPTIONS;
}

/**
 * The model the next run will actually use.
 *
 * **Always a real model when the provider offers any.** A stored preference the
 * current catalogue does not contain — routine, since the preference survives a
 * provider switch — falls through to the catalogue's first entry, which the
 * adapter contract defines as the provider's own default.
 *
 * There used to be a "Provider default" row in the picker representing the
 * absent case, and this returned `undefined` for it. It is gone: it named no
 * model, so it told the user nothing about what would run, and it sat at the
 * top of the list where it collected mis-clicks. Resolving to a concrete model
 * means every surface can name what the next run will use.
 */
export function activeModel(state: SessionState): ProviderModelOption | undefined {
  const models = activeModels(state);
  return models.find((m) => m.id === state.model) ?? models[0];
}

/**
 * The effort level the next run will actually use, resolved the same way.
 *
 * Falls back to the provider's documented default rather than to nothing, for
 * the same reason {@link activeModel} does — the thinking picker no longer
 * offers an "unset" rung to represent it.
 */
export function activeEffort(state: SessionState): ProviderEffortOption | undefined {
  const levels = activeEffortLevels(state);
  return levels.find((e) => e.id === state.effort) ?? levels.find((e) => e.id === DEFAULT_EFFORT);
}

/**
 * The provider's own default effort, mirrored here so the picker can preselect
 * it. `high` is what the SDK documents as the default when `effort` is omitted.
 */
const DEFAULT_EFFORT = 'high';

/* -------------------------------------------------------------------------- */
/* Thinking: one scale, from `low` up to ultracode                            */
/* -------------------------------------------------------------------------- */

/**
 * The id of the synthetic top rung.
 *
 * Ultracode is not an effort level the provider accepts — it is a *setting*
 * that rides `Options.settings` alongside a real effort. But to a user it is
 * plainly "more than max", and presenting it as a separate switch next to an
 * effort picker asks them to reason about a combination that has no meaning
 * (ultracode at `low` is a contradiction the provider resolves silently). So
 * the UI offers one ladder and this file does the translating: picking this
 * rung sets a real effort *and* the flag; picking any other clears the flag.
 */
export const ULTRACODE_LEVEL = 'ultracode';

/**
 * The effort ultracode implies.
 *
 * The provider states its own precondition — ultracode "requires an
 * xhigh-capable model" — so selecting the top rung pins effort there rather
 * than leaving whatever was set before, which could be `low`.
 */
const ULTRACODE_EFFORT = 'xhigh';

/** One rung of the thinking ladder, as the picker renders it. */
export interface ThinkingLevel {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  /**
   * False when the selected model does not offer this rung. The control renders
   * it disabled and *says nothing about why* — see the note on fast mode in
   * `StatusLine`. An unavailable rung is not an error to explain, it is simply
   * not on this model's ladder.
   */
  readonly available: boolean;
}

/**
 * The thinking ladder for the selected model, least to most.
 *
 * Built from the provider's own effort list, narrowed to what the selected
 * model accepts (`ProviderModelOption.effortLevels`), with ultracode appended
 * when the model supports it. A model that takes no effort setting at all
 * (`effortLevels: []`) yields an empty ladder and the control renders dead.
 *
 * The ultracode rung is appended only when *some* model in the catalogue offers
 * it, and disabled when the selected one does not — the hidden/disabled split
 * {@link providerOffersUltracode} explains. On Codex, which has no such concept,
 * the ladder simply ends at its top effort level instead of carrying a rung that
 * could never be reached.
 */
export function thinkingLevels(state: SessionState): readonly ThinkingLevel[] {
  const provider = activeEffortLevels(state);
  if (provider.length === 0) return NO_THINKING;

  return computeThinkingLevels(
    provider,
    selectedModelOption(state),
    providerOffersUltracode(state),
  );
}

/*
 * Memoised on input identity, and not for speed.
 *
 * This builds a fresh array, and it is read through `usePane(thinkingLevels)` —
 * a zustand selector. A new array on every store read fails zustand's identity
 * check every time, which re-renders, which reads again: React bails out with
 * "Maximum update depth exceeded" and the menu never opens. That is not
 * hypothetical; it is what happened, and `quickModels` above carries the same
 * guard for the same reason. Any selector in this file that constructs a value
 * must cache it on its inputs — and, since these run per pane, must cache one
 * result per pane. See {@link memoisePerPane}.
 *
 * `model` carries `supportsUltracode`, so it is not a separate input: two model
 * options that differ in it are different objects and miss the cache already.
 */
const computeThinkingLevels = memoisePerPane(
  (
    provider: readonly ProviderEffortOption[],
    model: ProviderModelOption | undefined,
    offersUltra: boolean,
  ): readonly ThinkingLevel[] => {
    // `undefined` means "every level the provider offers"; `[]` means none.
    const allowed = model?.effortLevels;
    const rungs: ThinkingLevel[] = provider
      .filter((level) => allowed === undefined || allowed.includes(level.id))
      .map((level) => ({ id: level.id, label: level.label, note: level.note, available: true }));

    if (rungs.length === 0) return NO_THINKING;
    if (!offersUltra) return rungs;
    return [
      ...rungs,
      {
        id: ULTRACODE_LEVEL,
        label: 'Ultracode',
        note: 'Maximum effort plus standing multi-agent orchestration. The most compute this model will spend on one turn.',
        available: model?.supportsUltracode === true,
      },
    ];
  },
);

const NO_THINKING: readonly ThinkingLevel[] = [];

/**
 * Which rung is selected — an effort id, or {@link ULTRACODE_LEVEL}.
 *
 * Ultracode wins when set, because it is the strictly higher rung: a state with
 * both `ultracode` and an effort is not ambiguous, the effort is the one
 * ultracode pinned.
 */
export function activeThinkingLevel(state: SessionState): string | undefined {
  if (state.ultracode) return ULTRACODE_LEVEL;
  return activeEffort(state)?.id;
}

/**
 * Move to a rung. Handles the effort/ultracode translation in one place.
 *
 * Fast mode is cleared on the way up for the same reason the two were made
 * mutually exclusive in the first place: it buys latency by spending depth and
 * ultracode does the reverse, so asking for both is a contradiction the
 * provider can only resolve silently.
 */
export function setThinkingLevel(id: string, pane: Pane = focusedPane()): void {
  if (id === ULTRACODE_LEVEL) {
    setPaneState(pane, { effort: ULTRACODE_EFFORT, ultracode: true, fastMode: false });
  } else {
    setPaneState(pane, { effort: id, ultracode: false });
  }
  rememberModelChoice(pane);
  savePrefs();
}

/**
 * The context window observed for the selected model, or `undefined`.
 *
 * Learned rather than declared: the provider reports a window only at run end
 * (`usage.contextWindow`), and nothing in the model catalogue carries one. So
 * this is blank until the model has completed a run, and that is the honest
 * state — the alternative is a hard-coded table of model specs, which goes
 * stale silently and shows a confidently wrong number.
 *
 * Keyed by the *resolved* wire id where the catalogue publishes one, because
 * that is what a run reports back. Falls back to the alias for a provider that
 * does not resolve.
 */
export function learnedContextWindow(state: SessionState): number | undefined {
  const model = selectedModelOption(state);
  if (!model) return undefined;
  return state.contextWindows[model.resolvedModel ?? model.id] ?? state.contextWindows[model.id];
}

/**
 * The git branch to show in the status line, or `undefined`.
 *
 * Read off the most recent session recorded for the current directory, because
 * the renderer cannot run `git` and there is no IPC channel that reports a
 * branch. That makes it a *last known* branch rather than a live one, and the
 * status line labels it accordingly — showing a possibly-stale branch as if it
 * were current would be worse than showing nothing.
 *
 * The `cwd` filter is load-bearing now that `sessions` spans every project: a
 * branch read off some *other* repository's history and shown next to this
 * directory would not be stale, it would be wrong.
 */
export function lastKnownBranch(state: SessionState): string | undefined {
  const cwd = state.cwd.trim();
  if (cwd.length === 0) return undefined;
  let best: SessionSummary | undefined;
  for (const session of state.sessions) {
    if (session.gitBranch === undefined || session.cwd !== cwd) continue;
    if (!best || session.updatedAt > best.updatedAt) best = session;
  }
  return best?.gitBranch;
}

/** The oldest permission request still awaiting an answer. */
export function pendingPermission(state: SessionState): PermissionRequest | undefined {
  return state.permissionQueue[0];
}

/* -------------------------------------------------------------------------- */
/* Error surface                                                              */
/* -------------------------------------------------------------------------- */

const MAX_BANNERS = 4;

export function pushBanner(level: Banner['level'], message: string, detail?: string): void {
  const banner: Banner = {
    id: newId('bnr'),
    level,
    message,
    ...(detail === undefined ? {} : { detail }),
    ts: Date.now(),
  };
  useApp.setState((s) => ({ banners: [...s.banners, banner].slice(-MAX_BANNERS) }));
}

export function dismissBanner(id: string): void {
  useApp.setState((s) => ({ banners: s.banners.filter((b) => b.id !== id) }));
}

export function clearBanners(): void {
  useApp.setState({ banners: [] });
}

function reportFailure(context: string, error: IpcError | AgentError): void {
  pushBanner('error', `${context}: ${error.message}`, describeError(error));
}

function describeError(error: IpcError | AgentError): string {
  const parts = [`code ${error.code}`];
  if (error.providerCode) parts.push(error.providerCode);
  if (error.httpStatus !== undefined) parts.push(`HTTP ${error.httpStatus}`);
  if (error.retryable) parts.push('retryable');
  return parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/** Subscribe to the live event feed. Call before starting anything. */
export function installEventBridge(): () => void {
  const { bridge } = resolveBridge();
  if (!bridge) return () => undefined;
  return bridge.runs.onEvent(handleAgentEvent);
}

/**
 * Subscribe to terminal output. Call alongside {@link installEventBridge}.
 *
 * Note what the `data` branch does *not* touch: the store. Output goes straight
 * into the xterm instance that owns those bytes, because a `setState` sixty
 * times a second per terminal would re-render the window to update a canvas
 * that repaints itself. `exit` is the one that writes, and it happens once.
 *
 * An event for a terminal this window has no session for is dropped in
 * `writeToTerminal` without ceremony. That is routine rather than exceptional:
 * push channels broadcast to every window, so a second window hears about the
 * first window's shells and has nowhere to put them.
 */
/**
 * Route browser events into the records that draw the chrome.
 *
 * The mirror of {@link installTerminalFeed}, and it drops unknown ids for the
 * same reason: push channels broadcast to every window, so a second Artemis
 * window hears about the first's pages and has nowhere to put them.
 *
 * A `gone` event removes the record outright. Main has already destroyed the
 * view by the time it sends one, so there is nothing left to draw and no
 * `browser.close` to send back — reloading it would put the reader back on the
 * page that had just crashed, which is a loop rather than a recovery.
 */
export function installBrowserFeed(): () => void {
  const { bridge } = resolveBridge();
  if (!bridge) return () => undefined;

  return bridge.browser.onEvent((event) => {
    if (event.type === 'gone') {
      const owner = useApp.getState().browsers.find((one) => one.info.id === event.id)?.owner;
      useApp.setState((state) => ({
        browsers: state.browsers.filter((browser) => browser.info.id !== event.id),
      }));
      const pane = owner === undefined ? null : (allPanes().find((one) => one.id === owner.paneId) ?? null);
      pane?.transcript.note('warn', 'A browser stopped responding', `The page was closed (${event.reason}).`);
      return;
    }

    if (event.type === 'opened') {
      /*
       * A browser the renderer did not ask for: an agent opened one with a
       * tool. The tab it produces is the whole point — the user watches the
       * agent browse rather than finding out afterwards.
       *
       * Attributed by run id to the pane running that run. A run this window
       * has never heard of is dropped: push channels broadcast, so a second
       * Artemis window hears about the first's agents.
       */
      const pane = allPanes().find((one) => paneState(one).run?.runId === event.runId);
      if (pane === undefined) return;
      useApp.setState((state) =>
        state.browsers.some((browser) => browser.info.id === event.id)
          ? {}
          : {
              // Deliberately *not* brought to the front. The agent works while
              // the user is reading something else, and stealing the dock out
              // from under them mid-sentence is what makes a helpful feature
              // feel like an interruption. The tab appears; clicking it is
              // theirs. `agentOpened` is what lets the dock-auto-open setting
              // go one further and keep the tab out of the strip entirely —
              // the record stays either way, because main is driving the page
              // and it must remain closeable, re-ownable, and revealable.
              browsers: [...state.browsers, { info: event.browser, owner: ownerFor(pane), agentOpened: true }],
            },
      );
      return;
    }

    useApp.setState((state) => {
      const index = state.browsers.findIndex((browser) => browser.info.id === event.id);
      if (index === -1) return {};
      const browser = state.browsers[index] as BrowserRecord;
      const browsers = [...state.browsers];
      browsers[index] = { ...browser, info: { ...browser.info, state: event.state } };
      return { browsers };
    });
  });
}

export function installTerminalFeed(): () => void {
  const { bridge } = resolveBridge();
  if (!bridge) return () => undefined;

  setTerminalSessionHooks({ onTitle: setTerminalTitle });

  return bridge.terminal.onEvent((event) => {
    if (event.type === 'data') {
      writeToTerminal(event.id, event.data);
      return;
    }
    noteTerminalExit(event.id, event.exitCode, event.signal);
    markTerminalExited(event.id);
  });
}

/**
 * Re-adopt the shells the main process is still holding, after a reload.
 *
 * The renderer's half of a terminal is an xterm instance and a subscription,
 * and a reload destroys both while leaving the shell running — the same
 * situation `adoptLiveRuns` handles for runs, and handled the same way: ask what
 * exists, then rebuild a view of it.
 *
 * Everything adopted is owned by the **focused pane**, which is a guess, and the
 * only one available: ownership is renderer state and it went with the old
 * window. It is the right guess in the case that matters — one conversation,
 * one window, a reload — and in a split it puts the tabs somewhere visible
 * rather than nowhere, which beats a shell that is running with no way to reach
 * it.
 */
/**
 * Re-adopt the pages the main process is still holding, after a reload.
 *
 * {@link adoptTerminals}'s twin, and simpler: the renderer's half of a browser
 * is a rectangle and a subscription, both of which the reload destroyed, while
 * the view itself never belonged to the renderer at all. Nothing has to be
 * rebuilt — the records just have to exist again so the strip can draw tabs for
 * views that are still very much alive behind it.
 *
 * Everything adopted is owned by the **focused pane**, which is a guess and the
 * only one available, for the reason `adoptTerminals` writes out.
 */
async function adoptBrowsers(pane: Pane): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const listed = await call(() => bridge.browser.list({}));
  if (!listed.ok || listed.value.browsers.length === 0) return;

  const owner = ownerFor(pane);
  useApp.setState({ browsers: listed.value.browsers.map((info) => ({ info, owner })) });
}

async function adoptTerminals(pane: Pane): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const listed = await call(() => bridge.terminal.list({}));
  if (!listed.ok || listed.value.terminals.length === 0) return;

  const owner = ownerFor(pane);
  const records: TerminalRecord[] = [];
  for (const info of listed.value.terminals) {
    const replayed = await call(() => bridge.terminal.replay({ id: info.id }));
    // Seeded with the retained tail, so a reattached tab shows a screenful
    // rather than opening blank onto a shell that has been working for an hour.
    ensureTerminalSession(info.id, replayed.ok ? replayed.value.data : '');
    records.push({ info, owner, title: lastSegment(info.shell), exited: info.exited });
  }

  useApp.setState({ terminals: records });
}

/**
 * Subscribe to the main process's plan-usage poll. Returns an unsubscribe.
 *
 * There is no timer here, and that is the point: the poll runs once in main
 * for the whole app, so a second window costs nothing and both windows see the
 * same numbers at the same moment. See `IPC_PUSH.planUsage`.
 *
 * The first push is up to a poll cycle away, so {@link seedPlanUsage} fills the
 * gap from main's cache — a window opened into a long-running app should not
 * have to wait five minutes to know which account has room.
 */
export function installPlanUsageFeed(): () => void {
  const { bridge } = resolveBridge();
  if (!bridge) return () => undefined;
  return bridge.usagePlan.onChange(({ profileId, usage }) => {
    useApp.setState((s) => ({
      planUsageByProfile: { ...s.planUsageByProfile, [profileId]: usage },
    }));
    considerHandoff();
  });
}

/**
 * How long after a run ends before its account is re-read.
 *
 * The same reasoning as {@link SESSION_SETTLE_MS} and a longer number: the turn
 * that just finished is still being accounted for on the provider's side when
 * `run.end` arrives, so a read taken immediately returns the figure from
 * *before* the work — the exact staleness this exists to remove, bought at the
 * price of a subprocess.
 */
const PLAN_USAGE_SETTLE_MS = 4_000;

/** Profiles with a settle timer already running, so a burst re-reads once. */
const planUsageSoon = new Map<ProfileId, ReturnType<typeof setTimeout>>();

/**
 * Re-read one account, because a run on it just finished.
 *
 * ## Why a finished run is the moment that matters
 *
 * The poll walks every profile serially — one CLI at a time, deliberately — so
 * with eight accounts any given one is re-read about every six minutes. A run
 * that just ended spent real budget that stays unmeasured for that whole window.
 *
 * While it was running, `planLoad`'s reservation covered it: the ranking knew
 * work was committed to that account even though the reading did not show it.
 * The moment it ends that cover is withdrawn — correctly, because the run is no
 * longer committing anything — and the account goes back to being ranked on a
 * reading taken before any of the work happened. It therefore reads emptiest at
 * precisely the moment it has just been drained, and wins the next session.
 *
 * That is the residual half of #146, and this closes it: one targeted read of
 * one profile, on the one event that made its number wrong.
 *
 * ## Once per burst
 *
 * Several runs on one account can finish within a second of each other —
 * a split view, or an ultracode fan-out settling. Each would otherwise spawn its
 * own CLI to ask the same question. The timer is keyed by profile and is *not*
 * restarted by a later end, so a burst is one read a fixed moment after the
 * first of them rather than a read that recedes for as long as work keeps
 * landing.
 *
 * Failures are silent by design. This is a background correction to a number
 * that a poll will fix on its own within minutes; a banner for it would be an
 * error message about something nobody asked for.
 */
function refreshPlanUsageSoon(profileId: ProfileId): void {
  if (planUsageSoon.has(profileId)) return;

  const timer = setTimeout(() => {
    planUsageSoon.delete(profileId);
    const { bridge } = resolveBridge();
    if (!bridge) return;
    void (async () => {
      const result = await call(() => bridge.usagePlan.refresh({ profileId }));
      // `null` is "nothing was learned", which is not the same as "nothing is
      // used" — writing it in would replace a good reading with an absence and
      // drop the account out of the ranking entirely. Leave what is there and
      // let the poll try again.
      if (!result.ok || result.value.usage === null) return;
      const usage = result.value.usage;
      // Written straight in rather than waited for on the push channel: the
      // push is what the *poll* broadcasts, and this read was asked for by this
      // window. Both land in the same map, and the later write wins — which is
      // this one, since it is the newer reading.
      useApp.setState((s) => ({
        planUsageByProfile: { ...s.planUsageByProfile, [profileId]: usage },
      }));
      // The moment this matters most. A run just ended, so this reading is the
      // freshest one this account will have for minutes — and an idle pane is
      // exactly where a handoff can be asked for without cutting anything off.
      considerHandoff();
    })();
  }, PLAN_USAGE_SETTLE_MS);

  planUsageSoon.set(profileId, timer);
}

/**
 * Longest the handoff will wait for an interrupted run to actually end.
 *
 * Bounded because the alternative is worse than being early. A provider that
 * ignores the interrupt, or one whose `run.end` is lost, would otherwise leave
 * the pane latched at `asked` with no document ever requested — the feature
 * silently doing nothing at the one moment it was supposed to act. Going ahead
 * after the deadline at least produces an attempt, and the attempt says what it
 * is in the transcript.
 */
const HANDOFF_SETTLE_MS = 10_000;

/** Resolve when the pane stops being live, or when `ms` has passed. */
function settled(pane: Pane, ms: number): Promise<void> {
  if (!isLive(paneState(pane))) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const unsubscribe = pane.store.subscribe((state) => {
      if (!isLive(state)) finish();
    });
  });
}

/**
 * Ask every conversation whether it should be handing its work over.
 *
 * Called after each write to `planUsageByProfile`, which is both places a
 * reading can arrive: the poll's push, and the read taken a few seconds after a
 * run ends. That single hook covers the two moments the feature is about — a
 * turn finishing on a nearly-spent account, and an account crossing its
 * threshold while a turn is still in flight — without either caller having to
 * know it is what triggers a handoff.
 *
 * Every pane, not just the focused one. A conversation running in the other
 * column is spending the same budget and is no less worth saving; a background
 * pane is arguably the one you would rather not have to reconstruct.
 */
function considerHandoff(): void {
  const state = useApp.getState();
  if (!state.autoHandoff) return;
  const now = Date.now();

  for (const pane of allPanes(state)) {
    const session = paneState(pane);
    const trigger = handoffReason({
      enabled: true,
      session,
      usageByProfile: state.planUsageByProfile,
      now,
    });
    if (!trigger) continue;

    // Latched before anything asynchronous, so a second reading landing while
    // the interrupt is in flight cannot start a second handoff.
    setHandoff(pane, 'stopping');
    pane.transcript.note(
      'warn',
      `Handing this work over — the ${trigger.threshold.label} limit is at ${String(trigger.utilization)}%`,
      'Artemis is asking for a handover document while there is still budget to write one. Turn this off in Appearance → Handing over.',
    );

    void requestHandoff(pane, trigger, now);
  }
}

/**
 * Stop whatever is running, then ask for the document.
 *
 * The interrupt comes first and is awaited: a provider mid-turn will not take
 * the prompt as its own turn, and sending it anyway would either queue it
 * behind the work being abandoned or fold it into that work as a steer. Neither
 * produces a document.
 *
 * `submitPrompt` is used rather than a bespoke call so the handoff request is an
 * ordinary turn in every respect — it appears in the transcript as a prompt, it
 * is subject to the same capability gating, and the run it starts ends the way
 * any other does.
 */
async function requestHandoff(pane: Pane, trigger: HandoffTrigger, now: number): Promise<void> {
  if (isLive(paneState(pane))) {
    await interruptRun(pane);
    // And then wait for it to actually be over. `interruptRun` returns when
    // main has *accepted* the interrupt; the pane does not settle until the
    // `run.end` it causes arrives on the event stream. Sending in that gap is
    // worse than not interrupting at all — `submitPrompt` would see a live run,
    // take the steer path, and fold the request for a handover into the turn
    // being abandoned, which produces no document and no clean stop.
    await settled(pane, HANDOFF_SETTLE_MS);
  }
  if (isLive(paneState(pane))) {
    // The run would not stop, so there is nowhere to put the request. Giving up
    // is the only honest option left, and it must not block the conversation:
    // no document was written, so refusing the user's next prompt would be
    // punishing them for a provider that ignored an interrupt.
    return abandonHandoff(pane, 'the run would not stop');
  }
  // Promoted only now, once the interrupted run's `run.end` is behind us: from
  // here the next run to end is the one this prompt starts, which is exactly
  // what `asked` means.
  setHandoff(pane, 'asked');
  const sent = await submitPrompt(handoffPrompt(trigger, handoffStamp(now)), undefined, pane);
  // Same rule one step later. `submitPrompt` refuses for reasons of its own — a
  // provider that cannot take a prompt, a directory that has gone away — and a
  // refusal means no document exists. `done` would block the conversation over
  // a handover that was never written.
  if (!sent) abandonHandoff(pane, 'the prompt could not be sent');
}

/**
 * Give up on this handoff without blocking the conversation.
 *
 * `dismissed` rather than `none`: nothing was written, so there is nothing to
 * stop for — but retrying on the next reading would interrupt the same run
 * again thirty seconds later, and again after that. One attempt, one
 * explanation, then out of the way.
 */
function abandonHandoff(pane: Pane, because: string): void {
  setHandoff(pane, 'dismissed');
  pane.transcript.note(
    'warn',
    'Could not hand this work over automatically',
    `Artemis tried to stop and ask for a handover document, but ${because}. Nothing has been blocked — this conversation carries on, and the account is still nearly spent.`,
  );
}

/** Drop every pending settle timer. For tests. */
export function resetPlanUsageSoon(): void {
  for (const timer of planUsageSoon.values()) clearTimeout(timer);
  planUsageSoon.clear();
}

/**
 * Prime the map from main's cache, one profile at a time.
 *
 * Cache reads only — `cached` never contacts a provider, so this is a handful
 * of cheap IPC round-trips rather than a subprocess per account. A profile
 * nobody has read yet answers `null` and is simply left out, which is the
 * honest state: not "no plan", but "not yet known".
 */
async function seedPlanUsage(profiles: readonly ProfileMetadata[]): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const seeded: Record<ProfileId, PlanUsage> = {};
  for (const profile of profiles) {
    const result = await call(() => bridge.usagePlan.cached({ profileId: profile.id }));
    if (result.ok && result.value.usage !== null) seeded[profile.id] = result.value.usage;
  }
  if (Object.keys(seeded).length === 0) return;

  // Merged *under* what is already there: a push that landed while these reads
  // were in flight is newer than the cache they came from.
  useApp.setState((s) => ({ planUsageByProfile: { ...seeded, ...s.planUsageByProfile } }));
}

export async function bootstrap(): Promise<void> {
  const { mode, bridge } = resolveBridge();
  const platform = bridge?.platform ?? 'darwin';
  useApp.setState({ bridgeMode: mode, version: bridge?.version ?? '', platform });
  // Before anything can arrive in a transcript, so the first artifact is judged
  // against the real platform rather than the default. See `pane.ts`.
  setHostPlatform(platform);

  if (!bridge) {
    useApp.setState({ booted: true });
    return;
  }

  // Main keeps no preferences of its own, so the update channel has to be sent
  // on every launch rather than only when it changes. It goes here, before the
  // first check can fire, because a beta user whose channel arrived late would
  // be told about the stable release they had already declined.
  void bridge.updates?.setChannel?.({ channel: useApp.getState().updateChannel });

  await Promise.all([refreshProviders(), refreshProfiles()]);
  await adoptLiveRuns(focusedPane());
  await adoptTerminals(focusedPane());
  await adoptBrowsers(focusedPane());
  await refreshSessions();
  useApp.setState({ booted: true });

  // Deliberately after `booted`, and deliberately not awaited. Fetching the
  // catalogue spawns a provider subprocess; blocking the first paint on it
  // would trade a working window for a slightly better-labelled model picker,
  // and the picker has the descriptor's list to render in the meantime.
  void refreshModels(focusedPane());
  // Same reasoning, cheaper call: the sidebar header renders the directory's
  // own name until this lands, which is a correct label either way.
  void refreshWorkspace(focusedPane());
  // One account, not all of them — see `refreshAuth`. After `booted` and not
  // awaited, for the same reason the two reads above are.
  refreshAuth(focusedPane());
  // Cache reads, so this contacts no provider — see `seedPlanUsage`. It is what
  // makes the profile menu's recommendation available immediately in a window
  // opened into an app that has been running for hours.
  void seedPlanUsage(useApp.getState().profiles);
  // The first boot after the shortlist became per-profile. A no-op every time
  // after that, because consuming the sentinel is what removes it.
  seedQuickModels(useApp.getState().profiles);
  // Last, and not awaited: the dock is the least important thing on screen at
  // launch, and reopening a browser must not hold up the transcript.
  void restoreDockLayout();
}

/**
 * Put the dock back the way it was.
 *
 * Runs once, after the panes exist — a terminal is started in *the pane's*
 * directory, which is restored from preferences a few lines above this, so the
 * order matters and is not incidental.
 *
 * ## An arrangement, not a session
 *
 * A browser comes back to its URL and a file to its path, and those are the
 * same things they were. A terminal is not: its process died with the app, so
 * what returns is the same *number* of shells in the same directory, empty. The
 * tabs are the workspace's shape rather than its contents, which is what every
 * editor that restores a window also means by it.
 *
 * ## Failures are silent on purpose
 *
 * Every step can legitimately fail — a file the agent has since deleted, a
 * directory that has moved, a page that will not load. None of them is worth a
 * banner at launch: the user did not ask for this to happen, they asked for it
 * *last time*, and a warning about a tab they may not have wanted back is worse
 * than the tab quietly not appearing.
 */
async function restoreDockLayout(): Promise<void> {
  const layout = useApp.getState().dockLayout;
  const pane = focusedPane();

  for (const url of layout.browsers) {
    await openBrowser(pane, url).catch(() => undefined);
  }
  for (let i = 0; i < layout.terminals; i += 1) {
    await openTerminal(pane).catch(() => undefined);
  }
  // References rather than bare paths: the viewer takes an optional line, and a
  // restored file has no line to be at — the reader was not sent there, they
  // left it open.
  for (const path of layout.files) {
    await openFile({ path }).catch(() => undefined);
  }
  if (layout.preview !== null) await openPreview(layout.preview, pane).catch(() => undefined);

  // Restored last, because every open above moves the front tab. The kind is
  // matched rather than the exact tab: the ids inside a stored one were minted
  // in a process that has exited.
  const wanted = layout.activeKind;
  if (wanted === null) return;
  const match = useApp.getState().visibleDockTabs.find((tab) => tab.kind === wanted);
  if (match) focusDockTab(match);
}

export async function refreshProviders(refresh = false): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;
  const result = await call(() => bridge.providers.list({ refresh }));
  if (!result.ok) {
    reportFailure('Could not list providers', result.error);
    return;
  }
  const providers = result.value.providers;
  useApp.setState({ providers });
  // Per column, because the selected provider is: a pane pointed at an adapter
  // that no longer exists has to land somewhere real, and the other column's
  // choice is none of its business.
  const firstAvailable = providers.find((p) => p.available) ?? providers[0];
  for (const pane of allPanes()) {
    setPaneState(pane, (s) =>
      providers.some((p) => p.id === s.activeProviderId)
        ? {}
        : { activeProviderId: firstAvailable?.id ?? s.activeProviderId },
    );
  }
}

export async function refreshProfiles(): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;
  const result = await call(() => bridge.profiles.list({}));
  if (!result.ok) {
    reportFailure('Could not list profiles', result.error);
    return;
  }
  const profiles = result.value.profiles;
  /*
   * Re-picking the active profile carries the provider with it, for the reason
   * `setProfile` gives. The last resort here is a profile belonging to some
   * *other* provider — the only account left after the active provider's were
   * all deleted — and adopting one of those without also moving
   * `activeProviderId` would point the app at an account its adapter has never
   * heard of. Preferring the active provider's own profiles first means that
   * fallback is reached only when there is genuinely nothing else.
   *
   * The account that is *already* selected is kept whatever its flags say —
   * this is a list refresh, and disabling a profile is not a reason to move the
   * app off it mid-session. `setProfile` is the only thing that changes who
   * pays, and it happens because someone asked. What the flags decide here is
   * only where the app lands when the selection has genuinely gone: see
   * `adoptableProfile`.
   */
  useApp.setState({ profiles });
  for (const pane of allPanes()) {
    setPaneState(pane, (s) => {
      const current = s.activeProfileId;
      if (current !== null && profiles.some((p) => p.id === current)) return {};

      const adopted =
        adoptableProfile(profiles, (p) => p.providerId === s.activeProviderId) ??
        adoptableProfile(profiles) ??
        null;
      return {
        activeProfileId: adopted?.id ?? null,
        activeProviderId: adopted?.providerId ?? s.activeProviderId,
      };
    });
  }
  savePrefs();
  invalidateSessions();
  void refreshSessions();
}

/**
 * Guards against an out-of-order catalogue response.
 *
 * The fetch spawns a provider subprocess, so it is slow enough that a user can
 * switch profile twice before the first answer lands. Without a token the
 * slower reply wins by arriving last and the picker ends up showing an account
 * the user is no longer signed in as — the same staleness `loadSessionHistory`
 * guards against, with a counter instead of an id because there is no id here.
 */
const modelsRequestToken = new Map<PaneId, number>();

/**
 * Follow one persisted model id from the catalogue it was chosen in into the
 * one replacing it.
 *
 * Ids are the app's handle on a model everywhere they are stored — the pinned
 * shortlist, the selected model — and they are *not stable across catalogues*.
 * The built-in list calls Fable `fable`; the live one the CLI publishes calls it
 * `claude-fable-5[1m]`. So the moment a live catalogue lands, every id stored
 * against the built-in list stops matching, and the models the user pinned drop
 * out of their own picker with no error and nothing to click.
 *
 * That is not hypothetical — it is what took Fable out of the composer's
 * picker while it sat plainly in the settings catalogue, since that pane lists
 * the whole catalogue and the picker lists the pins.
 *
 * The swap is the only moment both lists exist, which is why the fix lives here
 * rather than in the read path: `resolvedModel` can match the two rows to each
 * other (see `isSameModel`), but nothing can match a bare `fable` against a list
 * that has never heard the word.
 *
 * An id already in the new catalogue is left exactly as it is, and so is one the
 * old catalogue never had — a pin belonging to another provider survives a
 * switch, which is the behaviour `quickModels` documents.
 */
function carryModelId(
  id: string,
  from: readonly ProviderModelOption[],
  to: readonly ProviderModelOption[],
): string {
  if (to.some((m) => m.id === id)) return id;
  const previous = from.find((m) => m.id === id);
  if (previous === undefined) return id;
  return to.find((m) => isSameModel(previous, m))?.id ?? id;
}

/**
 * The same, for the pinned shortlist.
 *
 * Deduplicates, because two stale ids can land on one row — `opus` and
 * `opus[1m]` both become whatever the new list calls Opus — and a shortlist that
 * lists a model twice looks broken.
 *
 * Returns the original array when nothing moved, and that is not a micro
 * optimisation: `quickModels` memoises on this array's identity, so handing it a
 * fresh copy on every background refresh would defeat the memo and put a new
 * array through a zustand selector on every store read. Same hazard the
 * `NO_OPTIONS` note describes.
 */
function carryModelIds(
  ids: readonly string[],
  from: readonly ProviderModelOption[],
  to: readonly ProviderModelOption[],
): readonly string[] {
  const carried: string[] = [];
  for (const id of ids) {
    const next = carryModelId(id, from, to);
    if (!carried.includes(next)) carried.push(next);
  }
  const unchanged = carried.length === ids.length && carried.every((id, i) => id === ids[i]);
  return unchanged ? ids : carried;
}

/**
 * Fetch the model catalogue for the active provider and profile.
 *
 * Never throws and never leaves `modelsLoading` set. The failure path
 * deliberately keeps whatever catalogue is already loaded: this runs on every
 * profile switch, and a transient failure that emptied the list would take the
 * model picker away from under the user's cursor and replace it with a
 * "no models" state that is not true.
 */
export async function refreshModels(pane: Pane = focusedPane()): Promise<void> {
  const { bridge } = resolveBridge();
  const state = paneState(pane);

  // No profile means no credential, and the catalogue is a property of the
  // account rather than of the binary — there is nothing to authenticate as, so
  // there is nothing to ask. The descriptor's built-in list stands until a
  // profile exists.
  const profileId = state.activeProfileId;
  if (!bridge || !profileId) return;

  // Per pane, not per window: two columns signed in as two accounts fetch two
  // catalogues, and a shared counter would have whichever asked second silently
  // discard the other's answer.
  const token = (modelsRequestToken.get(pane.id) ?? 0) + 1;
  modelsRequestToken.set(pane.id, token);
  setPaneState(pane, { modelsLoading: true, modelsError: null });

  try {
    const result = await call(() =>
      bridge.providers.models({
        providerId: state.activeProviderId,
        profileId,
        ...(state.cwd.trim().length > 0 ? { cwd: state.cwd } : {}),
      }),
    );

    if (token !== modelsRequestToken.get(pane.id)) return;

    if (!result.ok) {
      // Not a banner. The picker still has a list to render — either a stale
      // live one or the descriptor's — so this is a footnote on a working
      // control, not an error the user has to dismiss.
      setPaneState(pane, { modelsError: result.error.message });
      return;
    }

    // `live: false` is the handler saying "this is the built-in list, nobody
    // confirmed it". Storing it anyway would make `activeModels` prefer a copy
    // of the descriptor over the descriptor, which is harmless but makes
    // "did the account answer?" unanswerable downstream. So only a confirmed
    // catalogue is stored, and the fallback stays the descriptor's own list.
    if (result.value.live) {
      // Read once, before the swap: `carryModelId` needs the outgoing catalogue,
      // and after `setState` there is no way back to it.
      const before = paneState(pane);
      const outgoing = activeModels(before);
      const models = result.value.models;
      // Only this profile's shortlist migrates. The catalogue that just arrived
      // belongs to one account, and renaming another account's pins against it
      // would be the old window-wide behaviour reintroduced through the back
      // door — `opus` in a Claude profile is not a stale id just because an
      // OpenCode catalogue has never heard of it.
      const pins = useApp.getState().quickModelIdsByProfile;
      const carried = carryModelIds(pins[profileId] ?? [], outgoing, models);
      const model = before.model === null ? null : carryModelId(before.model, outgoing, models);

      setPaneState(pane, { models, modelsError: null, model });
      // The conversation's own record is stored in whichever vocabulary was
      // current when it was made, so it needs the same migration the pins and
      // the pane's selection just had — otherwise reopening it restores an id
      // this catalogue has never heard of and the bar reads "(unavailable)"
      // until the next refresh repairs the pane but not the record.
      if (model !== before.model) rememberModelChoice(pane);
      const moved = carried !== (pins[profileId] ?? undefined) && carried.length > 0;
      if (moved) useApp.setState({ quickModelIdsByProfile: { ...pins, [profileId]: carried } });
      // Only when something actually moved. Persisting the carried ids is what
      // stops the migration from running again on every launch, and skipping the
      // write in the common case keeps a background refresh silent.
      if (moved || model !== before.model) savePrefs();
    } else {
      setPaneState(pane, { modelsError: null });
    }
  } finally {
    // In a `finally` because an early `return` above still has to clear the
    // spinner; only the newest request owns it, or a superseded reply would
    // stop the indicator for a fetch that is still running.
    if (token === modelsRequestToken.get(pane.id)) setPaneState(pane, { modelsLoading: false });
  }
}

/**
 * When each profile's sign-in state was last read. See {@link refreshAuth}.
 */
const authReadAt = new Map<ProfileId, number>();

/**
 * How long a sign-in reading is treated as current.
 *
 * A bound on repeats rather than a staleness rule. Switching account is a
 * deliberate act and re-reading on each one is in line with what `refreshModels`
 * beside it already costs — but `applyProfile` also fires from `newSession`'s
 * automatic adoption, which is *not* deliberate, so somebody starting several
 * sessions in a row would otherwise spawn a probe per session.
 */
const AUTH_FRESH_MS = 60_000;

/**
 * Read the sign-in state of the account this column is pointed at.
 *
 * ## Why only the active one
 *
 * `authByProfile` was written by exactly one thing — a card mounting on the
 * profiles screen — so until that screen had been opened it was empty, and it
 * was empty again after every reload because it is renderer state. The status
 * line's amber "signed out" therefore could not appear for an account nobody had
 * gone looking at, which is the wrong way round: the warning exists for the
 * person who has *not* been looking.
 *
 * The obvious repair is to read every profile at startup, and it is the wrong
 * one. Each read spawns the provider's CLI, so on the machine this was reported
 * from that is eight subprocesses during boot — the busiest moment in the
 * process — to colour seven rows nobody is about to run on. `seedPlanUsage`
 * declines the same trade for the same reason.
 *
 * So this reads *one* account: the one this column will bill next, at the
 * moments that answer can have changed. That is the only profile whose sign-in
 * state changes what the next prompt does, and it is one subprocess beside the
 * `refreshModels` this is called next to.
 *
 * The other rows in the picker keep saying nothing about sign-in, which stays
 * correct: unchecked is not evidence, and the bar's standing rule is that amber
 * means *checked and signed out*.
 */
function refreshAuth(pane: Pane = focusedPane()): void {
  const profileId = paneState(pane).activeProfileId;
  if (profileId === null) return;

  const last = authReadAt.get(profileId);
  if (last !== undefined && Date.now() - last < AUTH_FRESH_MS) return;
  authReadAt.set(profileId, Date.now());

  // `readAuthStatus` writes the result into `authByProfile` and is silent on
  // failure, which is what this wants: an unreadable profile is not a banner,
  // it is an account the bar goes on saying nothing about.
  void readAuthStatus(profileId);
}

/** Forget when each profile was last probed. For tests. */
export function resetAuthFreshness(): void {
  authReadAt.clear();
}

/**
 * Re-attach to every run that outlived the page.
 *
 * ⌘R reloads the renderer; it does not touch the main process, where the runs
 * actually live. So a reload used to be indistinguishable from a crash from the
 * user's side — the agents carried on working, invisibly, into transcripts that
 * no longer existed. This is the other half of that: `runs.list` says which
 * conversations are still going, `runs.events` says what they have said, and
 * both are replayed through the ordinary event path so a re-attached run renders
 * exactly like one that was never interrupted.
 *
 * The first run takes the open column and the rest go to the background, which
 * is a reasonable guess rather than a restoration — pane geometry is not
 * persisted, so there is nothing that says which column a given run was in.
 * What matters is that none of them is lost: every one is reachable from its row
 * in the sidebar.
 */
async function adoptLiveRuns(pane: Pane): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  // No `cwd` filter: a conversation the user backgrounded may well have been
  // working in another project, and dropping it because this column happens to
  // point somewhere else is the bug this function exists to fix.
  const result = await call(() => bridge.runs.list({}));
  if (!result.ok) return;

  const live = result.value.runs.filter((handle) => handle.status !== 'ended');
  const [first, ...rest] = live;
  if (first === undefined) return;

  /*
   * Backgrounded *before* they are attached, which is not a tidiness point.
   *
   * `openPane` registers a pane nowhere — it mints one and starts watching it,
   * and the caller decides where it lives. Until that pane is in the grid or in
   * `background`, `allLivePanes` does not list it, so `paneForRun` cannot find
   * it and `applyAgentEvent` drops every event addressed to its run.
   * `attachRun` routes the whole replay through exactly that path, so attaching
   * first and registering afterwards threw away each adopted run's transcript
   * in full.
   *
   * The run state survived it, because `attachRun` writes that through the pane
   * object it was handed rather than by routing — which is why the failure
   * looked like a conversation that was working but never printing rather than
   * like an empty column. It also never repaired itself: this function is the
   * only reader of the registry, and it runs once, at boot. A `run.end` lost
   * this way left the column live forever, so the next prompt was steered into
   * a run the registry had already retired ("Run … has already ended") and Stop
   * had nothing live to interrupt.
   *
   * Registering first also settles the sidebar's working light, which
   * `syncRunningSessions` recomputes from pane writes: the write that mattered
   * was `attachRun`'s, and it used to land while the pane was still invisible
   * to `allLivePanes`.
   */
  const adopted = rest.map((handle) => {
    const extra = openPane(seedSession());
    // The run goes on before the pane is backgrounded, not just inside
    // `attachRun` afterwards, so the pane is never in `background` while it
    // reads as finished. `pruneBackground` counts anything that is not live as
    // an ended conversation, and a column waiting for its replay would have
    // qualified — an eviction mid-loop would then drop the pane and orphan the
    // very run this function exists to rescue.
    setPaneState(extra, { run: fromHandle(handle) });
    return { pane: extra, handle };
  });
  if (adopted.length > 0) {
    useApp.setState((s) => ({ background: [...s.background, ...adopted.map((a) => a.pane)] }));
  }
  /*
   * Every run at once, which is not a speed optimisation — it is what stops one
   * conversation's reload from silencing another's.
   *
   * `attachRun` holds every live event for the run it is attaching (see
   * `replayBuffers`), and it holds them across two IPC round trips, one of which
   * reads a whole stored transcript through a lock the main process shares with
   * the sidebar's four-second poll and every other profile's history read. Run
   * *n* awaited behind runs 1…n-1 therefore held its stream for the sum of all
   * of their reads, and released the backlog in one burst when its turn finally
   * came. With several conversations live — the case this function exists for —
   * the last one adopted was frozen for as long as the whole queue took, and the
   * user watched an agent that was working the whole time appear to do nothing
   * and then finish instantly.
   *
   * The column's own run is in here rather than awaited above it, for the same
   * reason: it is the slowest one to replay (it has the most history) and it was
   * in front of all the others.
   *
   * Each attach touches only its own pane and its own buffer, so there is
   * nothing here for them to race over.
   */
  await Promise.all([
    attachRun(pane, first),
    ...adopted.map(({ pane: extra, handle }) => attachRun(extra, handle)),
  ]);
}

/**
 * Longest a re-attaching pane will hold its live stream back for a replay.
 *
 * The hold is correct — see {@link attachRun} — but it must be finite, because
 * what it is waiting on is not. `call` has no timeout, the reads behind it are
 * serialised process-wide in main, and a renderer that waits forever does not
 * degrade gracefully: it shows a conversation that has visibly stopped while the
 * agent goes on working into a buffer nobody drains.
 *
 * Generous, because expiring is the worse outcome of the two: it costs the
 * scrollback above the run. Eight seconds is far longer than the read takes when
 * nothing is contending, and short enough that a wedged one is a pause rather
 * than the rest of the session.
 */
const REPLAY_HOLD_MS = 8_000;

/** Returned by {@link withDeadline} when the work did not finish in time. */
const TIMED_OUT = Symbol('timed out');

async function withDeadline<T>(ms: number, work: () => Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });

  const running = work();
  // A rejection that lands *after* the deadline has no caller left to receive
  // it, and an unhandled one is a console error in a window that has already
  // recovered. This marks it handled without swallowing the early case, which
  // still rejects through the race below.
  running.catch(() => undefined);

  try {
    return await Promise.race([running, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Point a pane at a run already in progress, and rebuild its whole conversation.
 *
 * Two sources, joined at a seam neither of them could work out on its own:
 *
 *  - **Before the run** comes from the provider's session file, read with
 *    `limit: handle.historyOffset` — the count of stored messages taken the
 *    instant this run started. Every earlier turn, and not one line of this one.
 *  - **The run itself** comes from the registry's retained events, which is the
 *    only place a turn still being written exists in full.
 *
 * Reading the file without that limit is the obvious version and it is wrong:
 * the provider appends as the run goes, so the file already holds a partial
 * copy of the turn the replay is about to render, and the turn appears twice.
 * `historyOffset` exists to make that seam knowable — see `RunHandle`.
 *
 * The pane is bound *before* anything is fetched, and live events are held back
 * while both reads are in flight (see {@link handleAgentEvent}). Without that
 * hold, a token arriving during the round-trip would be applied ahead of the
 * history it belongs after, and the transcript would read out of order — a race
 * that only shows up on a reload during a fast turn, which is exactly when it
 * is least welcome.
 */
async function attachRun(pane: Pane, handle: RunHandle): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const previous = paneState(pane);
  /*
   * Delegated rows survive a re-attach onto the same conversation.
   *
   * `background.tasks` is run-scoped, and the run being attached here is
   * routinely not the one that delegated the work: a workflow outlives the turn
   * that launched it, and the turn that reports it finished is a continuation
   * with an id of its own. That run's retained events carry no rows at all, so
   * clearing unconditionally drops a live workflow's list on every adoption and
   * leaves the delegated button disabled with nothing left to reopen — the same
   * loss `isDisposable` describes, arriving by the other door.
   *
   * Cleared when the pane is being pointed at a *different* conversation, where
   * the rows on it genuinely belong to someone else. `permissionQueue` is
   * cleared either way: a parked request belongs to the run that opened it, and
   * that run is over.
   */
  const sameSession =
    handle.sessionId !== undefined &&
    (previous.resumeSessionId === handle.sessionId ||
      previous.run?.sessionId === handle.sessionId);

  replayBuffers.set(handle.runId, []);
  pane.transcript.reset();
  setPaneState(pane, {
    run: fromHandle(handle),
    activeProviderId: handle.providerId,
    activeProfileId: handle.profileId,
    cwd: handle.cwd,
    permissionQueue: [],
    ...(sameSession ? {} : { tasks: [], dismissedTasks: [], tasksRequested: false }),
    // The session the next prompt continues is this run's own. Set now rather
    // than waiting for `run.end`, because until it is set the sidebar cannot
    // mark the row the user needs in order to find this conversation again.
    ...(handle.sessionId === undefined ? {} : { resumeSessionId: handle.sessionId }),
  });

  let lastSeq = -1;
  /*
   * Cleared when the hold expires, so a read that lands afterwards knows not to
   * write. Without it a slow `replayEarlierTurns` would apply the conversation's
   * *history* underneath the live events that were released while it was still
   * in flight — the transcript out of order, which is the one thing the hold
   * exists to prevent.
   */
  let wanted = true;
  try {
    const replay = await withDeadline(REPLAY_HOLD_MS, async () => {
      await replayEarlierTurns(pane, handle, () => wanted);
      return call(() => bridge.runs.events({ runId: handle.runId }));
    });

    if (replay === TIMED_OUT) {
      wanted = false;
      pane.transcript.note(
        'warn',
        'Could not replay what this run has already done',
        'Reading it back took too long. It is still running, and everything from here on will appear normally.',
      );
      return;
    }

    if (!replay.ok) {
      pane.transcript.note(
        'warn',
        'Could not replay what this run has already done',
        `${replay.error.message} It is still running, and everything from here on will appear normally.`,
      );
      return;
    }

    if (replay.value.truncated) {
      pane.transcript.note(
        'info',
        'Showing the most recent part of this run',
        'The window was reloaded and the earliest events had already been dropped.',
      );
    }
    for (const event of replay.value.events) {
      applyAgentEvent(event);
      lastSeq = event.seq;
    }
  } finally {
    // Whatever arrived while the replay was in flight, minus anything the replay
    // already covered. In a `finally` because a failed fetch still has to
    // release the hold — otherwise the run streams into a buffer forever.
    const pending = replayBuffers.get(handle.runId) ?? [];
    replayBuffers.delete(handle.runId);
    for (const event of pending) if (event.seq > lastSeq) applyAgentEvent(event);
  }
}

/**
 * Put the turns that came before a re-attached run back above it.
 *
 * Silent in three cases, and each is a correct "there is nothing to show":
 * a run that opened its own session (`historyOffset` 0), one whose provider
 * cannot count its stored messages (absent — see `RunHandle.historyOffset`),
 * and one whose session id has not arrived yet, which has no file to read.
 *
 * A failed read is a note rather than a banner, exactly as in
 * {@link loadSessionHistory}: the run is live and continuing, and the cost of
 * the failure is scrollback, not work.
 *
 * The synthetic run id is the same one `loadSessionHistory` uses, and for the
 * same reason — this is history, and stamping it with the live run's id would
 * make the two indistinguishable inside the transcript.
 */
async function replayEarlierTurns(
  pane: Pane,
  handle: RunHandle,
  /**
   * Whether the answer is still wanted by the time it arrives.
   *
   * Read *after* the await, because that is the only place it can have changed:
   * {@link attachRun} gives up on a read that outruns its hold, and history
   * applied after the live stream has been released would land below the turn it
   * came before.
   */
  stillWanted: () => boolean = () => true,
): Promise<void> {
  const { bridge } = resolveBridge();
  const { sessionId, historyOffset } = handle;
  if (!bridge || sessionId === undefined || historyOffset === undefined || historyOffset <= 0) {
    return;
  }

  const result = await call(() =>
    bridge.sessions.messages({
      profileId: handle.profileId,
      sessionId,
      runId: `history:${sessionId}` as RunId,
      cwd: handle.cwd,
      limit: historyOffset,
    }),
  );

  if (!stillWanted()) return;

  if (!result.ok) {
    pane.transcript.note(
      'warn',
      'Could not load the earlier part of this conversation',
      `${result.error.message} The run below is still going, and is shown in full.`,
    );
    return;
  }

  for (const event of result.value.events) pane.transcript.apply(event);
}

function fromHandle(handle: RunHandle): RunState {
  return {
    runId: handle.runId,
    status: handle.status,
    providerId: handle.providerId,
    profileId: handle.profileId,
    cwd: handle.cwd,
    capabilities: handle.capabilities,
    startedAt: handle.startedAt,
    ...(handle.sessionId === undefined ? {} : { sessionId: handle.sessionId }),
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The profile to land on when the app has to choose one for the user.
 *
 * Three routes reach this — the active provider changed, the selected profile
 * was deleted, prefs named an account that no longer exists — and none of them
 * is a request to use a particular account. So the availability flags apply, in
 * the order they were asked for:
 *
 *  1. **Preferably one in the pool.** Landing on an account the user told
 *     Artemis not to pick is the whole thing `autoSelect: false` asks it not to
 *     do, and here it would do it silently.
 *  2. **Failing that, any enabled one.** An opt-out is a preference and a
 *     disabled account is a wall, so the preference yields first. Someone whose
 *     every account is out of the pool still has to end up somewhere real.
 *  3. **Failing that, nothing.** `null` leaves the pane with no profile, which
 *     the composer already handles — it is the first-run state. Adopting a
 *     disabled account to avoid an empty selection would put the app on the one
 *     account the user hid from the menu, and leave them looking at a picker
 *     that does not list what it says is selected.
 *
 * `where` narrows the candidates before any of that, which is how the provider
 * switch says "this provider's accounts only".
 */
function adoptableProfile(
  profiles: readonly ProfileMetadata[],
  where: (profile: ProfileMetadata) => boolean = () => true,
): ProfileMetadata | undefined {
  const candidates = profiles.filter(where);
  return candidates.find(isProfileAutoSelectable) ?? candidates.find(isProfileEnabled);
}

export function setProvider(providerId: ProviderId, pane: Pane = focusedPane()): void {
  setPaneState(pane, (s) => ({
    activeProviderId: providerId,
    activeProfileId:
      s.profiles.find((p) => p.id === s.activeProfileId)?.providerId === providerId
        ? s.activeProfileId
        : (adoptableProfile(s.profiles, (p) => p.providerId === providerId)?.id ?? null),
    // Cleared, unlike on a profile switch: a catalogue belongs to a provider,
    // and leaving the old one loaded would have `activeModels` hand the new
    // provider's picker a list of models it cannot run. The descriptor's own
    // list covers the gap until the fetch lands.
    models: [],
    modelsError: null,
  }));
  // The session list is the *window's*, and it is provider-scoped in the
  // backend — so a provider switch in either column empties it and re-reads.
  // That is not a column's business leaking into the window; it is the one
  // list both columns browse, and it can only be pointed at one account at a
  // time. See `refreshSessions`.
  useApp.setState({ sessions: [] });
  savePrefs();
  invalidateSessions();
  void refreshSessions();
  void refreshModels(pane);
  // The account moved, so "is it signed in" is a different question now.
  refreshAuth(pane);
}

/**
 * Point a column at an account, with no rule about sessions attached.
 *
 * The write and the reads that follow from it, and nothing else. Split out
 * because there are two kinds of caller and only one of them is a user changing
 * their mind: {@link setProfile} is the gesture and owns the session rules,
 * while {@link newSession} adopts a recommended account as *part of building a
 * fresh session* — at which point there is no session to protect and the rules
 * would either be no-ops or, if `seedBeside` ever carried a session id forward,
 * a recursion.
 *
 * ## The provider moves with it
 *
 * A profile belongs to exactly one CLI, so selecting one selects that CLI too.
 * This is the same rule `createProfile` states at length, and it is stated in
 * both places because both are routes to "which account runs" — leaving a Codex
 * profile active while `activeProviderId` still said `claude` would ask the
 * Claude adapter to answer for an account it has never heard of.
 */
function applyProfile(pane: Pane, profile: ProfileMetadata): void {
  const switched = paneState(pane).activeProviderId !== profile.providerId;
  setPaneState(pane, {
    activeProfileId: profile.id,
    activeProviderId: profile.providerId,
    // Cleared only when the provider actually changes, for the reason
    // `setProvider` gives — a catalogue and a session list both belong to the
    // provider they came from. Within one provider the catalogue is *not*
    // cleared: the loaded list is still the right shape of answer and is very
    // likely the same one, so showing it until the new account replies beats
    // flashing the picker back to the built-in list and forward again.
    ...(switched ? { models: [], modelsError: null } : {}),
  });
  if (switched) useApp.setState({ sessions: [] });
  savePrefs();
  invalidateSessions();
  void refreshSessions();
  void refreshModels(pane);
  // The account moved, so "is it signed in" is a different question now.
  refreshAuth(pane);
}

/**
 * Point the app at an account — which, like moving the directory, starts a new
 * conversation.
 *
 * ## A session belongs to the account it started on
 *
 * This used to swap `activeProfileId` and return. It did not end the session,
 * did not clear `resumeSessionId`, and said nothing — so the next message
 * spawned under a different account and resumed a transcript that lives in the
 * *previous* profile's `projects/` directory. A session id only resolves under
 * the config directory it was written in, so that is a cross-store resume: it
 * either fails several seconds after the user has typed a prompt, or — where the
 * shared-config feature has symlinked `projects/` across profiles — succeeds and
 * quietly bills the wrong account for the continuation of someone else's
 * conversation.
 *
 * The directory half of this rule already existed: `setCwd` refuses while a run
 * is live and otherwise starts a new session, because "a session belongs to the
 * directory it started in". The account is exactly the same kind of fact — it is
 * *the* fact, since it decides which credentials authenticate and which plan is
 * billed — so it now behaves the same way. Two doors to "which account runs",
 * one rule behind both.
 *
 * ## What that costs, stated plainly
 *
 * Switching accounts mid-conversation is no longer possible. Hitting a plan
 * limit halfway through a session means starting a new session on the other
 * account rather than continuing this one there. That is a real loss, and it is
 * the honest one: continuing "there" was never actually happening — it was
 * resuming a transcript the new account cannot see, or billing it for one it
 * never had.
 *
 * A live run refuses outright rather than ending itself, for the reason `setCwd`
 * gives: killing work in progress is not plausibly what someone reaching for the
 * account picker meant to ask for.
 *
 * An unknown id is ignored rather than applied. It can only come from a stale
 * render of a profile that has since been deleted, and honouring it would point
 * the app at an account that is not there.
 */
export function setProfile(profileId: ProfileId, pane: Pane = focusedPane()): void {
  const state = paneState(pane);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) return;

  // Re-selecting the account that is already active is not a session change —
  // the same allowance `setCwd` makes for re-picking the current directory,
  // which its native picker produces on every "Browse… → Choose".
  if (profileId === state.activeProfileId) return;

  if (isLive(state)) {
    pushBanner(
      'warn',
      'A run is still going',
      'Interrupt it first. A session belongs to the account it started on, so moving accounts would have to end this one.',
    );
    return;
  }

  const leaving = state.resumeSessionId !== null || state.run !== null;
  // Without the profile hop, which would be this function undoing itself: the
  // account the user just picked is the point.
  if (leaving) newSession(pane, { adoptRecommendedProfile: false });

  applyProfile(pane, profile);

  // After `newSession`, which resets the very transcript this is written into.
  if (leaving) {
    pane.transcript.note(
      'info',
      'Started a new session',
      `The account moved to ${profile.label}, and a session only resumes under the account it was created on.`,
    );
  }
}

/**
 * Point the working column at a directory.
 *
 * ## Moving the directory ends the session rather than dragging it along
 *
 * A session id is not portable — Claude files transcripts under the directory
 * they ran in, so an id only resolves against that directory. (The long version
 * of this is in {@link resumeSession}, which is the same fact read backwards:
 * selecting a session moves the directory to match it.)
 *
 * Leaving `resumeSessionId` set across a change here would aim the next prompt
 * at a session the new directory has never heard of, and that failure does not
 * surface until several seconds after the user has typed a prompt, as a
 * provider error about a session id they never saw. So the selection is cleared
 * and the transcript starts blank.
 *
 * That is the pairing `ProjectSwitcher` used to write by hand — `newSession()`
 * and then `setCwd()`, in that order, with a comment explaining why the order
 * mattered. Doing it here instead makes every route to a directory correct by
 * construction rather than by memory: the status line, the palette, the empty
 * state and the switcher now all get the same behaviour, and a fifth one added
 * later gets it without knowing this rule exists.
 *
 * A live run is the one case that refuses. Ending it is a real loss of work and
 * not plausibly what someone reaching for a folder picker meant to ask for, so
 * this says what is in the way and changes nothing.
 */
export function setCwd(cwd: string, pane: Pane = focusedPane()): void {
  const next = cwd.trim();
  const state = paneState(pane);

  // Re-picking the directory that is already selected is not a session change.
  // It is also not unusual: the native picker *opens at* the current directory,
  // so "Browse… → Choose" with no navigation lands here every time.
  if (next === state.cwd) return;

  if (isLive(state)) {
    pushBanner(
      'warn',
      'A run is still going',
      'Interrupt it first. A session belongs to the directory it started in, so moving the directory would have to end this one.',
    );
    return;
  }

  const leaving = state.resumeSessionId !== null || state.run !== null;
  // The reset without the profile hop — see `newSession` on why a directory
  // change must not move which account pays.
  if (leaving) newSession(pane, { adoptRecommendedProfile: false });

  setPaneState(pane, { cwd: next });
  rememberFolder(next);
  savePrefs();
  invalidateSessions();
  void refreshSessions();
  void refreshWorkspace(pane);

  // After `newSession`, which resets the very transcript this is written into.
  if (leaving) {
    pane.transcript.note(
      'info',
      'Started a new session',
      `The working directory moved to ${next}, and a session only resumes in the directory it was created in.`,
    );
  }
}

/**
 * Re-read what the working directory is called.
 *
 * Cleared to `null` first, so the header falls back to the directory's own name
 * for the moment the read is in flight rather than keeping the *previous*
 * directory's repository name on screen — a stale answer here is worse than no
 * answer, because both look equally authoritative.
 *
 * The reply is dropped when the directory has moved on again underneath it.
 * Two directory changes in quick succession are ordinary (a click in the
 * project switcher is two `setCwd` calls apart from a click in the picker), and
 * without the check the slower of the two replies wins.
 */
export async function refreshWorkspace(pane: Pane = focusedPane()): Promise<void> {
  const { cwd } = paneState(pane);
  setPaneState(pane, { workspace: null });

  const names = await describeWorkspace(cwd);
  // Before the staleness check, deliberately. Which project a directory belongs
  // to is true whether or not the pane is still pointed at it, and a directory
  // the user moved through in the meantime is one the sidebar is about to group.
  rememberProject(cwd, names?.projectRoot);
  if (paneState(pane).cwd !== cwd) return;
  setPaneState(pane, { workspace: names });
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Directories already asked about, so each is asked once.
 *
 * Kept beside the map rather than derived from it, because the interesting
 * answer is the *absent* one: a repository root maps to itself and is therefore
 * not stored (see {@link AppState.projectRoots}), and without this the listing
 * poll would re-ask about every such directory every few seconds for an answer
 * it already has.
 *
 * Never cleared. A directory's project changes when somebody runs `git init` in
 * it or deletes a worktree out from under a session, and re-reading the whole
 * history on the chance of that is a worse trade than a label that is right
 * again on the next launch.
 */
const askedAboutProject = new Set<string>();

/** Record one directory's project, when it is somewhere else. */
function rememberProject(cwd: string, projectRoot: string | undefined): void {
  const path = cwd.trim();
  askedAboutProject.add(path);
  if (projectRoot === undefined || projectRoot.length === 0 || projectRoot === path) return;
  useApp.setState((s) =>
    s.projectRoots[path] === projectRoot
      ? {}
      : { projectRoots: { ...s.projectRoots, [path]: projectRoot } },
  );
}

/**
 * Find out which project each of these directories belongs to.
 *
 * Called with every directory in a listing, and cheap to call that way: the ones
 * already answered are dropped here, so a poll that returns the same two hundred
 * sessions costs a set lookup each and no IPC at all.
 *
 * The unknown ones go out together and land in one write, because they arrive as
 * independent replies and a `setState` per reply would regroup the sidebar once
 * per directory — a list visibly reassembling itself on first paint. Nothing
 * awaits this: the rows are already on screen, grouped by their own directories,
 * and the answers move some of them under the project they were split off from.
 */
async function learnProjects(cwds: Iterable<string>): Promise<void> {
  const unknown: string[] = [];
  for (const cwd of cwds) {
    const path = cwd.trim();
    if (path.length === 0 || askedAboutProject.has(path)) continue;
    // Added on the way out rather than on the way back, so two listings in
    // flight at once do not both ask about the same directory.
    askedAboutProject.add(path);
    unknown.push(path);
  }
  if (unknown.length === 0) return;

  const found = await Promise.all(
    unknown.map(async (cwd) => [cwd, (await describeWorkspace(cwd))?.projectRoot] as const),
  );

  const learned: Record<string, string> = {};
  for (const [cwd, projectRoot] of found) {
    // Only the ones that group elsewhere. See `AppState.projectRoots`.
    if (projectRoot !== undefined && projectRoot.length > 0 && projectRoot !== cwd) {
      learned[cwd] = projectRoot;
    }
  }
  if (Object.keys(learned).length === 0) return;
  useApp.setState((s) => ({ projectRoots: { ...s.projectRoots, ...learned } }));
}

/**
 * Open the host's folder chooser and adopt what comes back.
 *
 * Returns the outcome rather than reporting it, so the control that opened the
 * dialog can render the failure *on itself*. A native picker that refuses — the
 * path is not a directory, the dialog could not open — has a specific reason,
 * and the caller shows that reason verbatim instead of "something went wrong".
 */
export async function chooseWorkingDirectory(pane: Pane = focusedPane()): Promise<DirectoryChoice> {
  const choice = await pickDirectory(paneState(pane).cwd);
  if (choice.status === 'chosen') setCwd(choice.path, pane);
  return choice;
}

/* -------------------------------------------------------------------------- */
/* Recent folders                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The recording in progress, so the next one waits behind it.
 *
 * Module-level because the order being protected is the *list's*, and there is
 * one list per window. Nothing awaits it: a caller that blocked on this would
 * be blocking a directory change on a menu's bookkeeping.
 */
let recording: Promise<void> = Promise.resolve();

/**
 * Record that a directory was worked in — unless it is not going to last.
 *
 * Not exported, and that is the design: the list means "directories this window
 * actually adopted", so the only things allowed to write it are the two places
 * that adopt one — {@link setCwd} and {@link resumeSession}, which writes `cwd`
 * itself for reasons of its own. A surface that could add an entry without
 * moving there would let the menu offer folders the app has never been in.
 *
 * Called *after* the write, never before: `setCwd` refuses while a run is live,
 * and a folder the user was told they could not move to has no business at the
 * top of the list of folders they have been in.
 *
 * ## What is declined, and why
 *
 * Two kinds of directory, for one reason: this menu is an offer to take
 * somebody back somewhere later, and neither of them will be there.
 *
 *  - **A linked worktree** is a checkout made for one branch and deleted when
 *    that branch lands. Submodules are deliberately *not* included — same
 *    `.git` file, permanent place to be working.
 *  - **A temporary directory** is deleted by the OS, and usually sooner by
 *    whatever made it.
 *
 * Working in either is completely ordinary and stays that way: moving there is
 * not refused, the header still names it, and its sessions still list. Only the
 * remembering is declined, because a menu of ten "where have I been lately"
 * rows silts up with directories that no longer exist and each one evicts a
 * real project that does.
 *
 * Resuming an agent session is how most of them arrive, since a session started
 * in a scratch checkout keeps that path forever and continuing it a week later
 * is exactly the trip this menu exists to save. See `describeWorkspace` and
 * `isTemporaryPath` in core for how each is recognised.
 *
 * ## Why the entry lands late, and what that costs
 *
 * Neither answer is available here: one needs the filesystem and the other
 * needs `tmpdir()`, and the renderer has neither. So both come over the bridge
 * in one call and the entry lands a tick after the directory does. The
 * alternative was to record first and retract on the answer, which would put a
 * folder in the menu and take it out again; a list nobody edits by hand should
 * not visibly change its mind.
 *
 * Returns void rather than the promise, because there is nothing a caller could
 * usefully do with it — moving to a directory does not wait on the menu's
 * bookkeeping, and it cannot fail in a way worth reporting.
 *
 * That tick is also why {@link recordFolder} saves for itself. Both callers run
 * `savePrefs` immediately after calling this, which now happens *before* the
 * write does — so without that second save the folder would be in the menu and
 * absent from the next launch.
 */
function rememberFolder(path: string): void {
  // Queued rather than fired, so the list keeps the order the directories were
  // adopted in. Without this the *reply* order decides, and the replies are
  // independent filesystem walks that can overtake each other — which would
  // make the eviction order wrong for exactly the user who moves fast enough to
  // care about it. See {@link recording}.
  recording = recording.then(() => recordFolder(path));
}

/** One queued recording. See {@link rememberFolder} for why it is queued. */
async function recordFolder(path: string): Promise<void> {
  const next = path.trim();
  // Both are no-ops that would otherwise pay for a trip through the bridge:
  // "" is not a folder anyone can go back to, and a folder already at the front
  // is what `promoteFolder` would hand straight back. The second is the common
  // case for `resumeSession` on a session in the directory already open.
  if (next.length === 0) return;
  if (useApp.getState().recentFolders[0] === next) return;

  const names = await describeWorkspace(next);
  // `null` when the bridge has no `describe` channel, and `undefined` on a
  // preload older than these fields. Both mean "cannot tell", and the answer
  // that changes no behaviour is the one that records.
  if (names?.worktree === true || names?.temporary === true) return;

  let recorded = false;
  useApp.setState((s) => {
    const recentFolders = promoteFolder(s.recentFolders, next);
    // `promoteFolder` hands back the same array when nothing moved, and this
    // runs on every directory adoption — returning a fresh object each time
    // would re-render every menu subscriber for a no-op.
    if (recentFolders === s.recentFolders) return {};
    recorded = true;
    return { recentFolders };
  });
  if (recorded) savePrefs();
}

/**
 * Drop directories from the folder menu. One, or a selection of them.
 *
 * Takes a list rather than a single path because both shapes of the same
 * request exist in Appearance — the × on a row, and "Remove selected" over a
 * set of checkboxes — and a loop of single removes would write and persist the
 * preferences once per folder, so a half-finished multi-remove would be a real
 * state someone could quit inside of.
 *
 * Forgetting a folder is bookkeeping and nothing else. It does not touch the
 * working directory (the current one can be forgotten, and the session carries
 * on where it is), it does not touch that directory's sessions in the sidebar,
 * and it certainly does not touch the directory. The next time the folder is
 * opened it returns to the top of the list, which is what makes this a low-cost
 * edit rather than a decision — there is no undo and none is needed.
 */
export function forgetFolders(paths: readonly string[]): void {
  const drop = new Set(paths);
  if (drop.size === 0) return;
  useApp.setState((s) => {
    const recentFolders = s.recentFolders.filter((folder) => !drop.has(folder));
    return recentFolders.length === s.recentFolders.length ? {} : { recentFolders };
  });
  savePrefs();
}

/** Forget every remembered folder. The menu falls back to "Add folder…". */
export function clearRecentFolders(): void {
  if (useApp.getState().recentFolders.length === 0) return;
  useApp.setState({ recentFolders: [] });
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

export function setSidebarCollapsed(collapsed: boolean): void {
  useApp.setState({ sidebarCollapsed: collapsed });
  savePrefs();
}

export function toggleSidebar(): void {
  useApp.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
  savePrefs();
}

/** Commit a dragged width. Clamped here so no caller can persist a silly one. */
export function setSidebarWidth(width: number): void {
  useApp.setState({ sidebarWidth: clampSidebarWidth(width) });
  savePrefs();
}

/**
 * Fold one project's sessions shut, or open them.
 *
 * Stored as the list of *collapsed* directories rather than open ones, so the
 * default for a project nobody has touched — including every project that
 * appears for the first time after this preference was written — is open. The
 * opposite polarity would have a new project arrive folded shut, which reads as
 * the list having lost it.
 */
export function toggleProjectCollapsed(cwd: string): void {
  useApp.setState((s) => ({
    collapsedProjects: s.collapsedProjects.includes(cwd)
      ? s.collapsedProjects.filter((entry) => entry !== cwd)
      : [...s.collapsedProjects, cwd],
  }));
  savePrefs();
}

/** Open or shut the sidebar's Archived section. */
export function toggleArchivedExpanded(): void {
  useApp.setState((s) => ({ archivedExpanded: !s.archivedExpanded }));
  savePrefs();
}

/**
 * Fold the sidebar's Pinned section shut, or open it.
 *
 * Note the polarity, which is the archive's inverted: see
 * {@link AppState.pinnedCollapsed} for why pinned opens by default and archived
 * does not.
 */
export function togglePinnedCollapsed(): void {
  useApp.setState((s) => ({ pinnedCollapsed: !s.pinnedCollapsed }));
  savePrefs();
}

export function setPermissionMode(mode: PermissionMode, pane: Pane = focusedPane()): void {
  setPaneState(pane, { permissionMode: mode });
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* The model choice, and the conversation it was made for                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything the model popover decides, as one value.
 *
 * One type rather than four fields passed around separately, because the status
 * line already presents them as one choice — model, thinking rung, fast mode —
 * and remembering a subset would hand a conversation back on its own model at
 * someone else's effort. See {@link AppState.modelBySession}.
 */
export interface ModelChoice {
  readonly model: string | null;
  readonly effort: string | null;
  readonly fastMode: boolean;
  readonly ultracode: boolean;
}

/**
 * File this column's model choice under the conversation showing in it.
 *
 * Called from every setter that moves one of the four, and again from
 * {@link resumeSession} and {@link newSession} on the way out of a
 * conversation. The second is not belt and braces: a new session has no id
 * until its first run reports one, so a model picked before the first prompt is
 * chosen at a moment there is nothing to file it under. Recording again as the
 * column is repointed catches it, by which time the id has arrived.
 *
 * A column showing no conversation records nothing. There is no key for it, and
 * the blank session's choice is already the column's own — which is what the
 * next one inherits.
 *
 * Re-inserted rather than assigned in place, so the key order stays the age
 * order {@link capModelMemory} prunes by: a conversation touched today must not
 * be evicted because it was first opened a year ago.
 */
function rememberModelChoice(pane: Pane): void {
  const state = paneState(pane);
  const sessionId = sessionShownBy(state);
  if (sessionId === null) return;

  const choice: ModelChoice = {
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    ultracode: state.ultracode,
  };

  useApp.setState((s) => {
    const before = s.modelBySession[sessionId];
    if (
      before !== undefined &&
      before.model === choice.model &&
      before.effort === choice.effort &&
      before.fastMode === choice.fastMode &&
      before.ultracode === choice.ultracode
    ) {
      // Identity preserved on the common path — every setter calls this, and a
      // fresh object each time would rewrite the preferences file on a click
      // that changed nothing.
      return {};
    }

    const next = { ...s.modelBySession };
    delete next[sessionId];
    next[sessionId] = choice;
    return { modelBySession: capModelMemory(next) };
  });
}

/**
 * What a conversation was last left running on, or `undefined`.
 *
 * `undefined` — no entry — is the ordinary state for every conversation that
 * predates this, and it means "no preference", never "the default". The caller
 * leaves the column on what it was using rather than blanking the picker.
 */
function recalledModelChoice(sessionId: SessionId): ModelChoice | undefined {
  return useApp.getState().modelBySession[sessionId];
}

/** Choose the model for the next run. `null` means the provider's default. */
export function setModel(model: string | null, pane: Pane = focusedPane()): void {
  setPaneState(pane, { model });
  rememberModelChoice(pane);
  savePrefs();
}

/** Choose the reasoning effort for the next run. `null` means the default. */
export function setEffort(effort: string | null, pane: Pane = focusedPane()): void {
  setPaneState(pane, { effort });
  rememberModelChoice(pane);
  savePrefs();
}

export function setForkOnResume(fork: boolean, pane: Pane = focusedPane()): void {
  setPaneState(pane, { forkOnResume: fork });
}

/**
 * Wind this conversation back to just before one of its user messages — or
 * branch a fork there, leaving the original whole.
 *
 * The two are one move with one flag because they are the same move: the next
 * run resumes the session truncated at that message (see
 * `RunInput.rewindToMessageId`), and `fork` only decides whether the provider
 * keeps writing under the same session id or mints a new one. What differs on
 * screen is nothing — either way the transcript is cut back to the message and
 * its text lands in the composer, ready to be retyped or resent.
 *
 * Refusals are silent no-ops rather than banners because every one of them is
 * a state the controls are already hidden in: a live run, a message still
 * pending, a conversation with no session on disk to wind back.
 */
export function rewindConversationTo(
  itemId: string,
  { fork }: { readonly fork: boolean },
  pane: Pane = focusedPane(),
): void {
  const state = paneState(pane);
  if (isLive(state)) return;
  if (!activeCapabilities(state).rewind) return;
  if (fork && !activeCapabilities(state).forkSession) return;

  const sessionId = state.resumeSessionId ?? state.run?.sessionId ?? null;
  if (sessionId === null) return;

  const item = pane.transcript.getItem(itemId);
  if (item?.kind !== 'user' || item.messageId === undefined || item.pending) return;

  pane.transcript.truncateFrom(itemId);
  pane.transcript.flush();
  setPaneState(pane, {
    resumeSessionId: sessionId,
    rewindToMessageId: item.messageId,
    forkOnResume: fork,
    // The message being wound past goes back in the composer — a rewind is
    // almost always "let me say that differently", and retyping it from
    // memory is the cost this control exists to remove.
    draft: item.text,
  });
}

export function setScreen(screen: Screen): void {
  useApp.setState({ screen, paletteOpen: false });
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Open the settings surface, optionally on a specific pane.
 *
 * Omitting the section reopens wherever the user was last, which is the right
 * default for the generic "⌘, / gear" entry points. Passing one is for the
 * deep links — "manage models" under the model picker, "permissions" from a
 * denied tool call — where the whole point of the click was a destination.
 */
export function openSettings(section?: SettingsSection): void {
  useApp.setState({
    screen: 'profiles',
    paletteOpen: false,
    ...(section === undefined ? {} : { settingsSection: section }),
  });
  savePrefs();
}

/**
 * Open Settings whenever the macOS menu bar asks.
 *
 * The menu is main's — on macOS the application menu belongs to the app rather
 * than to any window — so the click cannot reach this store any other way. See
 * {@link IPC_PUSH.menuOpenSettings}.
 *
 * Opens; never closes. The menu item has no accelerator and does not read as a
 * toggle, and a menu pick that shut a dialog the user was reading would be a
 * surprise. `⌘,` is still the toggle, and it is still the renderer's.
 */
export function installSettingsMenuFeed(): () => void {
  const { bridge } = resolveBridge();
  if (!bridge) return () => undefined;
  return bridge.menu.onOpenSettings(() => openSettings());
}

/** Close settings and go back to the conversation. */
export function closeSettings(): void {
  // `settingsSection` is left alone on purpose: it is a preference for where to
  // land next time, not a piece of the open dialog's state.
  useApp.setState({ screen: 'chat' });
}

export function setSettingsSection(section: SettingsSection): void {
  useApp.setState({ settingsSection: section });
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Model preferences                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pin or unpin one model from the status-line picker.
 *
 * Stores the id rather than the option, for the same reason {@link AppState.model}
 * does: the list is persisted and survives provider switches and catalogue
 * changes, where the option object may no longer exist. Ids that match nothing
 * are simply filtered out at read time — see {@link quickModels} — so there is
 * no cleanup pass and no way for a stale pin to break the picker.
 */
export function toggleQuickModel(id: string, pane: Pane = focusedPane()): void {
  const profileId = paneState(pane).activeProfileId;
  // No profile means no catalogue was ever fetched and no entry to key. Storing
  // pins under a null profile would strand them: nothing reads that key back.
  if (profileId === null) return;

  const current = useApp.getState().quickModelIdsByProfile[profileId] ?? [];
  writeQuickModels(
    profileId,
    current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
  );
}

/** Replace one profile's pinned set — for a settings pane that edits it as a list. */
export function setQuickModels(ids: readonly string[], pane: Pane = focusedPane()): void {
  const profileId = paneState(pane).activeProfileId;
  if (profileId === null) return;
  writeQuickModels(profileId, [...ids]);
}

/**
 * Write one profile's entry, dropping it entirely when it empties.
 *
 * Deleting rather than storing `[]` keeps the two indistinguishable states from
 * both existing on disk: an empty array and an absent key both mean "not
 * curated", and a prefs file that carried empty arrays for every profile ever
 * opened would grow without ever saying anything.
 */
function writeQuickModels(profileId: ProfileId, ids: readonly string[]): void {
  useApp.setState((s) => {
    const next = { ...s.quickModelIdsByProfile };
    if (ids.length === 0) delete next[profileId];
    else next[profileId] = ids;
    return { quickModelIdsByProfile: next };
  });
  savePrefs();
}

/**
 * Turn fast mode on or off for the next run.
 *
 * Stored unconditionally, even when the selected model does not support it.
 * The flag is a standing preference and the model is not — a user who enables
 * fast mode, switches to a model without it and switches back should find it
 * still on. {@link fastModeAvailable} gates the *control*, and
 * {@link submitPrompt} gates what is actually sent; neither erases the choice.
 *
 * ## Turning this on turns ultracode off, here rather than in the controls
 *
 * Fast mode buys latency by spending depth; ultracode does the exact reverse.
 * Asking for both is not a stronger request, it is a contradiction, and the
 * only thing an adapter can do with it is pick one silently — after which the
 * status line is reporting a setting the run did not use.
 *
 * The exclusion lives in the *action* because that is the only place it cannot
 * be bypassed. It was briefly implemented as a wrapper next to the status-line
 * toggles instead, on the reasoning that the exclusion is a property of how
 * that pair of controls behaves rather than of either setting, and that a
 * settings pane editing defaults as a form might legitimately want to set one
 * without disturbing the other. That is exactly what went wrong: the settings
 * pane called the plain setters, and the app happily reached a state with both
 * flags on and the bar advertising both. An invariant that each new surface has
 * to remember to opt into is not an invariant.
 */
export function setFastMode(on: boolean, pane: Pane = focusedPane()): void {
  setPaneState(pane, on ? { fastMode: true, ultracode: false } : { fastMode: false });
  rememberModelChoice(pane);
  savePrefs();
}

/** The same, for ultracode. @see setFastMode for why the two are exclusive. */
export function setUltracode(on: boolean, pane: Pane = focusedPane()): void {
  setPaneState(pane, on ? { ultracode: true, fastMode: false } : { ultracode: false });
  rememberModelChoice(pane);
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                 */
/* -------------------------------------------------------------------------- */

export function setConversationWidth(width: ConversationWidth): void {
  useApp.setState({ conversationWidth: width });
  savePrefs();
}

export function setRunSummary(summary: RunSummary): void {
  useApp.setState({ runSummary: summary });
  savePrefs();
}

/**
 * Set the base text size, in px.
 *
 * The clamp is here rather than only in the controls because this is reachable
 * from more than the pair of buttons that currently call it — and a setting
 * that writes `--font-scale` straight onto the document is one where an
 * out-of-range value is not a rendering glitch but a window the user may not be
 * able to read well enough to fix.
 */
export function setFontSize(size: number): void {
  const next = clampFontSize(size);
  useApp.setState({ fontSize: next });
  applyFontScale(next);
  savePrefs();
}

/**
 * Turn the per-word fade on streaming text on or off.
 *
 * Takes effect on the next word, not the next run: `StreamingText` reads this
 * live, and a block mid-stream when it is switched off simply stops pacing and
 * shows what arrives.
 */
export function setStreamingWordFade(on: boolean): void {
  useApp.setState({ streamingWordFade: on });
  savePrefs();
}

/**
 * Whether a reasoning block opens on arrival, or waits for a click.
 *
 * One write, not four. It used to move rows as well as open them — reasoning
 * was machinery when this was off, and got folded into the activity marker with
 * the tool calls — so every transcript on screen and the pane layer behind them
 * all had to be told. Reasoning is a message in the thread now, always, and the
 * only thing left to decide is whether it arrives expanded. `ThinkingRow` reads
 * this from the store and adjusts itself, so the rows on screen follow without
 * being rebuilt.
 */
export function setShowThinking(on: boolean): void {
  useApp.setState({ showThinking: on });
  savePrefs();
}

/**
 * Decide whether the dock may open, or grow a tab, without being asked.
 *
 * `reconcileDock` runs on the write, which is what makes the switch take
 * effect immediately in both directions: turning it off retracts the tabs the
 * agent put up (their records survive — see `visibleTabs`), and turning it on
 * reveals whatever arrived while it was off.
 */
export function setDockScope(scope: 'pane' | 'all'): void {
  useApp.setState({ dockScope: scope });
  savePrefs();
}

export function setDockAutoOpen(on: boolean): void {
  useApp.setState({ dockAutoOpen: on });
  savePrefs();
  reconcileDock();
}

export function setEscapeStopsRun(on: boolean): void {
  useApp.setState({ escapeStopsRun: on });
  savePrefs();
}

export function setAutoHandoff(on: boolean): void {
  useApp.setState({ autoHandoff: on });
  savePrefs();
  // Turning it on judges the readings already in hand rather than waiting for
  // the next poll: someone who switches this on while sitting at 96% meant it
  // to apply to the account they are looking at.
  if (on) considerHandoff();
}

/**
 * Let this conversation carry on despite the account being nearly spent.
 *
 * A one-way door on purpose — nothing re-arms it for the rest of the
 * conversation. A safeguard that keeps re-asking after being told no is not a
 * safeguard.
 */
export function dismissHandoff(pane: Pane = focusedPane()): void {
  setHandoff(pane, 'dismissed');
}

/**
 * Record that the user has taken up — or backed out of — the shared
 * `~/.claude` arrangement.
 *
 * Changes nothing on disk. Artemis does not link these directories; the
 * Advanced pane hands over a script and the user runs it. What this decides is
 * which script that pane offers, so calling it is a claim about intent rather
 * than a report of what the filesystem now looks like.
 *
 * Turning it on latches the acknowledgement, and turning it off deliberately
 * does not clear it: the acknowledgement is the record that this user has met
 * the feature, and it is what makes the undo script reachable after the toggle
 * goes back down. Callers are expected to have shown the warning first — this
 * is the write, not the gate.
 */
export function setSharedClaudeConfig(on: boolean): void {
  useApp.setState((s) => ({
    sharedClaudeConfig: on,
    sharedClaudeConfigAcknowledged: s.sharedClaudeConfigAcknowledged || on,
  }));
  savePrefs();
}

/**
 * Choose which releases this installation is offered.
 *
 * `beta` widens what the updater considers rather than pointing it somewhere
 * else: a beta user is still offered the stable release once it is the newest
 * thing, because "beta" means *earlier*, not *a different product*. Going back
 * to `stable` never uninstalls anything — it only stops future prereleases
 * being offered, so someone on 1.1.0-beta.3 stays there until 1.1.0 ships.
 * That is the honest behaviour, and the pane says so.
 */
export function setUpdateChannel(channel: UpdateChannel): void {
  useApp.setState({ updateChannel: channel });
  savePrefs();
  // The main process holds no preferences of its own, so it has to be told.
  // Deliberately fire-and-forget: the preference is already saved, and an
  // unreachable bridge means the next launch tells it again at startup.
  void resolveBridge().bridge?.updates?.setChannel?.({ channel });
}

export function setPalette(open: boolean): void {
  useApp.setState({ paletteOpen: open });
}

export function togglePalette(): void {
  useApp.setState((s) => ({ paletteOpen: !s.paletteOpen }));
}

export function setInfo(open: boolean): void {
  useApp.setState({ infoOpen: open, paletteOpen: false });
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many sessions the sidebar asks for.
 *
 * Generous, because the list is virtualised and grouped by project — a user
 * with twenty repositories has a long history that is still cheap to render.
 * The cap exists so a pathological history cannot pin the main process.
 */
const SESSION_PAGE_SIZE = 500;

/**
 * Whether a listing is already in flight.
 *
 * Guards re-entrancy rather than queueing: the feed below fires from several
 * independent triggers (a poll, a lifecycle event, the window regaining focus)
 * which routinely coincide, and every listing reads the same directories off
 * disk. A second concurrent read cannot see anything the first will not, so it
 * is dropped rather than stacked.
 *
 * That last sentence is only true while the *question* stays the same, which is
 * what `sessionsGeneration` below tracks.
 */
let sessionsInFlight = false;

/**
 * Which selection the in-flight listing is answering for.
 *
 * A listing is a question about a specific (provider, profile, directory), read
 * once at the top of `refreshSessions` and answered several hundred milliseconds
 * later. Between those two moments the user can change any of the three, and
 * both halves of that race were visibly wrong:
 *
 *  - **The answer outlived the question.** The resolved listing wrote the *old*
 *    provider's sessions over a list that had already been cleared for the new
 *    one. The sidebar repopulated with history that did not belong to the
 *    account it was now pointed at, and stayed that way until the next poll —
 *    up to `SESSION_POLL_IDLE_MS` — at which point the rows vanished again.
 *  - **The new question was never asked.** `setProvider` and friends clear the
 *    list and immediately call back here, which the re-entrancy guard dropped
 *    on the floor because a poll happened to be running. Nothing re-read until
 *    the timer came round, so the sidebar sat empty for twenty seconds having
 *    been told to refill instantly.
 *
 * A counter fixes both. It is bumped by every selection change, a listing
 * captures it, and a listing whose capture no longer matches is discarded on
 * arrival rather than written. `sessionsQueued` then re-runs the read for the
 * selection that superseded it.
 */
let sessionsGeneration = 0;

/** Set when a refresh was asked for while one was in flight. */
let sessionsQueued = false;

/**
 * Invalidate any listing still in flight, and note that a new one is owed.
 *
 * Called by everything that changes which sessions the sidebar should be
 * showing. Cheap enough to call unconditionally — the cost of a spurious bump is
 * one extra directory read.
 */
function invalidateSessions(): void {
  sessionsGeneration += 1;
}

/**
 * Carry the old local archive onto the provider's own records, once.
 * ============================================================================
 *
 * Archiving used to be a set of keys in this window's preferences. It is a tag
 * on the session now — see {@link toggleSessionArchived} — and this is what
 * stops the change from reading, to anyone who had archived anything, as the
 * app having forgotten all of it.
 *
 * Runs after a listing, because it needs the sessions to match keys against,
 * and it only ever *adds* tags: a row the old set named is tagged, and the key
 * is dropped. Nothing is untagged here. Somebody may have tagged a session from
 * the CLI, and an entry missing from a set that never knew about it is not
 * evidence of anything.
 *
 * Providers that cannot tag are skipped and their keys kept. Codex has no tag
 * to write, so its archive stays local and stays working; discarding the keys
 * would delete the only record of it. That is the one place the two halves
 * still differ, and it is bounded by what the provider can actually do.
 *
 * Idempotent by construction: it consumes the set it reads from, so the second
 * run has nothing to do.
 */
async function migrateArchivedSessions(): Promise<void> {
  const state = useApp.getState();
  if (state.archivedSessions.length === 0) return;

  const { bridge } = resolveBridge();
  if (!bridge) return;

  const canTag = new Set(
    state.providers.filter((provider) => provider.capabilities.tagSession).map((p) => p.id),
  );
  if (canTag.size === 0) return;

  const migrated = new Set<string>();
  for (const session of state.sessions) {
    if (!canTag.has(session.providerId) || isArchived(session)) continue;
    const hits = entriesFiling(session, state.archivedSessions);
    if (hits.length === 0) continue;

    const result = await call(() =>
      bridge.sessions.tag({
        profileId: session.profileId,
        sessionId: session.id,
        tag: ARCHIVED_TAG,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      }),
    );
    // A failure keeps the key, so the row stays archived on the old mechanism
    // and the next listing tries again. Silent: this is a background repair of
    // something the user did not ask for, and a banner per failed row would be
    // a wall of noise about work nobody requested.
    //
    // `tagged: false` keeps the key too. "Nothing there to tag" is a success
    // for the caller who asked for a state of the world, but here it means no
    // tag was written — consuming the key on that answer deletes the only
    // record that the row was archived.
    if (result.ok && result.value.tagged) for (const hit of hits) migrated.add(hit);
  }

  if (migrated.size === 0) return;
  useApp.setState((s) => ({
    archivedSessions: s.archivedSessions.filter((entry) => !migrated.has(entry)),
  }));
  savePrefs();
}

export async function refreshSessions(): Promise<void> {
  const { bridge } = resolveBridge();
  const app = useApp.getState();
  /*
   * The focused column's selection, and only as a *fallback*.
   *
   * The modern listing channel enumerates every provider and every directory
   * and ignores all three of these — see `listSessionsEverywhere`. They matter
   * only on the old per-directory path, where something has to be asked about,
   * and the focused column is the conversation the user is looking at. A split
   * does not make the sidebar two lists; it is one history, and each row says
   * which account and project it belongs to.
   */
  const state = paneState(focusedPane(app));

  /*
   * Deliberately not gated on the active provider's `listSessions`.
   *
   * It was, and that emptied the sidebar every time the selected account
   * changed to one whose CLI cannot enumerate history — signing into Codex
   * blanked every Claude session on screen. The listing spans providers, so
   * "can the provider I happen to have selected list its own history" is the
   * wrong question to ask of it: the backend already skips adapters that cannot
   * answer and returns everything else, and what the user is owed is the record
   * of what they have done rather than a view onto the current selection.
   *
   * The sidebar still says so, above the rows rather than in place of them —
   * see `SessionList`.
   */
  if (!bridge) {
    useApp.setState({ sessions: [], sessionsError: null, sessionsLoading: false });
    return;
  }

  // Coalesced rather than dropped. A concurrent read cannot see anything the
  // one already running will not — but only if it is asking the same question,
  // and the caller may well be here *because* the question just changed. The
  // flag makes the in-flight read run again on the way out.
  if (sessionsInFlight) {
    sessionsQueued = true;
    return;
  }
  sessionsInFlight = true;
  const generation = sessionsGeneration;

  /*
   * The spinner is only raised on the *first* listing. Afterwards this runs on
   * a timer, and flipping a loading flag every few seconds would put a
   * permanent flicker in the sidebar for a refresh the user did not ask for and
   * does not need to know about. A background poll should be invisible until it
   * changes something.
   */
  const first = app.sessions.length === 0;
  if (first) useApp.setState({ sessionsLoading: true, sessionsError: null });

  try {
    const listing = await listSessionsEverywhere({
      providerId: state.activeProviderId,
      profileId: state.activeProfileId,
      cwd: state.cwd,
      limit: SESSION_PAGE_SIZE,
    });

    // The selection moved while this was reading. Every field below describes
    // an account or a directory the sidebar is no longer pointed at, so the
    // whole listing is dropped — including `sessionsLoading`, which belongs to
    // the newer read now. The queued re-run below is what fills the list.
    if (generation !== sessionsGeneration) return;

    useApp.setState((s) => ({
      sessionsLoading: false,
      // Reference-stable when nothing changed. `sessions` is the sidebar's
      // subscription, so handing back a fresh array every poll would re-render
      // the whole list several times a minute for no reason.
      sessions: sameSessions(s.sessions, listing.sessions) ? s.sessions : listing.sessions,
      sessionsScope: listing.scope,
      sessionsError: listing.error ?? null,
    }));

    // After the write, and not awaited: the sidebar groups by directory until
    // these land and by project afterwards, and a listing should not wait on a
    // walk of the filesystem to put rows on screen. See `learnProjects`.
    void learnProjects(listing.sessions.map((session) => session.cwd));

    // Also after the write, and for the same reason: it needs the rows this
    // listing just produced to match its keys against, and it repairs history
    // rather than deciding what is on screen now. See `migrateArchivedSessions`.
    void migrateArchivedSessions();
  } finally {
    sessionsInFlight = false;
    /*
     * Re-run for whatever superseded this read.
     *
     * Also covers the discarded-generation path above: a stale listing returns
     * without writing anything, and if nothing re-read after it the sidebar
     * would keep the empty list its caller cleared. Both routes out of the
     * `try` pass through here, which is why this lives in the `finally` — a
     * listing that threw still owes the queued caller an answer.
     */
    if (sessionsQueued) {
      sessionsQueued = false;
      void refreshSessions();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Session mutations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Retitle a session, optimistically.
 *
 * The row is rewritten before the call goes out, because a rename is the one
 * edit here whose result the user is staring at: waiting a round trip to
 * redraw the label they just typed reads as the app not having heard them. The
 * write is small and the failure path restores exactly what was there, so the
 * cost of being wrong is one flicker and a banner that says why.
 *
 * The *stored* title is what lands in the end, not the typed one — the main
 * process trims and caps, and it answers with what it wrote. Rendering the
 * request instead would leave the sidebar disagreeing with the transcript over
 * trailing whitespace nobody can see.
 */
export async function renameSession(session: SessionSummary, title: string): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;

  const next = title.trim();
  // Nothing to do, and nothing to report: the field was closed unchanged, which
  // is how most rename dialogs end.
  if (next.length === 0 || next === session.title) return false;

  const key = sessionKey(session);
  const previous = session.title;
  const apply = (value: string, custom: boolean): void => {
    useApp.setState((s) => ({
      sessions: s.sessions.map((entry) =>
        sessionKey(entry) === key ? { ...entry, title: value, titleIsCustom: custom } : entry,
      ),
    }));
  };

  apply(next, true);

  const result = await call(() =>
    bridge.sessions.rename({
      profileId: session.profileId,
      sessionId: session.id,
      title: next,
      ...(session.cwd.length > 0 ? { cwd: session.cwd } : {}),
    }),
  );

  if (!result.ok) {
    apply(previous, session.titleIsCustom ?? false);
    reportFailure('Could not rename that session', result.error);
    return false;
  }

  // The stored title, which may differ from what was sent.
  apply(result.value.title, true);
  return true;
}

/**
 * Put a session away, or take it back out.
 * ============================================================================
 *
 * A tag on the provider's own record, not a note Artemis keeps.
 *
 * This used to be a list of ids in the renderer's preferences, and that was
 * wrong in a way that took three separate bug reports to see whole. An archive
 * held here is a fact about *one installation*: invisible to a second build,
 * absent on another machine reading the same `~/.claude`, and gone entirely the
 * moment the window's storage is reset. All three happened. Meanwhile `delete`
 * and `rename` had never had the problem, because both were always the
 * provider's operation.
 *
 * So archiving is `tagSession`, beside them, and the tag comes back on every
 * listing as {@link SessionSummary.tag}. There is no local set to keep in step
 * with anything, which is what makes the whole class of bug unreachable rather
 * than fixed.
 *
 * Optimistic, then corrected. The row moves the moment it is clicked — waiting
 * on a subprocess to redraw a sidebar is the wrong trade — and `refreshSessions`
 * replaces the guess with what the provider actually stored. A failure puts the
 * row back and says why.
 *
 * Archiving unpins, always. The two are opposite claims about one row, and a
 * session that was both would have to be drawn twice or arbitrarily once.
 * Pinning stays local: it is a claim about how *this* person wants their
 * sidebar ordered, not a property of the conversation, and no provider has a
 * concept to delegate it to.
 */
export async function toggleSessionArchived(session: SessionSummary): Promise<void> {
  const wasArchived = isArchived(session);
  const tag = wasArchived ? null : ARCHIVED_TAG;

  // Optimistic, and the pin is cleared in the same write so the row cannot be
  // seen in two sections between here and the refresh below.
  const pinnedHits = new Set(entriesFiling(session, useApp.getState().pinnedSessions));
  useApp.setState((s) => ({
    sessions: s.sessions.map((row) =>
      row.id === session.id && row.profileId === session.profileId
        ? withTag(row, tag)
        : row,
    ),
    pinnedSessions: s.pinnedSessions.filter((entry) => !pinnedHits.has(entry)),
  }));
  savePrefs();

  const { bridge } = resolveBridge();
  if (!bridge) return;

  const result = await call(() =>
    bridge.sessions.tag({
      profileId: session.profileId,
      sessionId: session.id,
      tag,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    }),
  );

  if (!result.ok || !result.value.tagged) {
    // Put it back. An archive that appeared to work and did not is worse than
    // one that refused: the row would return at the next listing with no
    // explanation, which is the report this whole change came from. That
    // includes `tagged: false` — the provider found nothing to write to, so
    // nothing was stored and the optimistic row is a lie.
    useApp.setState((s) => ({
      sessions: s.sessions.map((row) =>
        row.id === session.id && row.profileId === session.profileId
          ? withTag(row, wasArchived ? ARCHIVED_TAG : null)
          : row,
      ),
    }));
    const context = wasArchived ? 'Could not restore that session' : 'Could not archive that session';
    if (!result.ok) {
      reportFailure(context, result.error);
    } else {
      pushBanner('error', `${context}: the provider has no record of it`);
    }
    return;
  }

  // What the provider stored is the answer; the optimistic write was a guess.
  void refreshSessions();
}

/** A copy of `session` carrying `tag`, or with the field absent for `null`. */
function withTag(session: SessionSummary, tag: string | null): SessionSummary {
  const { tag: _previous, ...rest } = session;
  return tag === null ? rest : { ...rest, tag };
}

/**
 * Keep a session in front of the user, or stop.
 *
 * The mirror of {@link toggleSessionArchived} in every respect: local only, no
 * IPC, and the row moves out of its project — up into the Pinned section rather
 * than down into Archived. Pinning unarchives for the same reason archiving
 * unpins; see there.
 */
export function toggleSessionPinned(session: SessionSummary): void {
  const key = sessionKey(session);
  useApp.setState((s) => {
    // See the note in `toggleSessionArchived`.
    const pinnedHits = new Set(entriesFiling(session, s.pinnedSessions));
    const archivedHits = new Set(entriesFiling(session, s.archivedSessions));
    return {
      pinnedSessions:
        pinnedHits.size > 0
          ? s.pinnedSessions.filter((entry) => !pinnedHits.has(entry))
          : [...s.pinnedSessions, key],
      archivedSessions: s.archivedSessions.filter((entry) => !archivedHits.has(entry)),
    };
  });
  savePrefs();
}

/**
 * Destroy a session's transcript. There is no undo.
 *
 * Not optimistic, unlike {@link renameSession}, and the asymmetry is the point:
 * a rename that fails costs a flicker, whereas a delete that fails after the
 * row has already gone tells the user their data is destroyed when it is still
 * there. So the row survives until the main process confirms the file did not.
 *
 * Callers are responsible for having asked the user first — see
 * `DeleteSessionDialog`. This does not confirm anything.
 */
export async function deleteSession(session: SessionSummary): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;

  const result = await call(() =>
    bridge.sessions.delete({
      profileId: session.profileId,
      sessionId: session.id,
      ...(session.cwd.length > 0 ? { cwd: session.cwd } : {}),
    }),
  );

  if (!result.ok) {
    reportFailure('Could not delete that session', result.error);
    return false;
  }

  const key = sessionKey(session);
  useApp.setState((s) => {
    // Every entry that filed this session, for the sweeps. A shared transcript
    // is one file, so deleting it deletes it for all the sharers, and an entry
    // filed under any of their keys is now stale — including one written under
    // a profile that has since left the arrangement, which is exactly the
    // entry the canonical key would miss. See `entriesFiling`.
    const archivedHits = new Set(entriesFiling(session, s.archivedSessions));
    const pinnedHits = new Set(entriesFiling(session, s.pinnedSessions));
    return {
      sessions: s.sessions.filter((entry) => sessionKey(entry) !== key),
      // Swept together with the row. An archive key for a session that no
      // longer exists is inert, but it would accumulate in the persisted
      // preferences forever, and a session id that came round again would
      // arrive pre-hidden.
      archivedSessions: s.archivedSessions.filter((entry) => !archivedHits.has(entry)),
      // Same for the pin, where the stale entry is louder: a recycled id would
      // arrive at the very top of the sidebar under a heading the user did not
      // put it in.
      pinnedSessions: s.pinnedSessions.filter((entry) => !pinnedHits.has(entry)),
    };
  });
  // A deleted session cannot be resumed, and leaving it selected would aim the
  // next prompt at a transcript that is gone.
  //
  // Every pane, not just the focused one: the same session can be open in more
  // than one column — the sidebar row marks it active while it is showing
  // anywhere — and clearing only the pane the user happened to right-click from
  // would leave the others pointed at a file that no longer exists.
  //
  // `allLivePanes`, not `allPanes`: "every pane" has to include the backgrounded
  // conversations too. A pane the user navigated away from keeps its
  // `resumeSessionId`, and coming back to it after the delete would aim its next
  // prompt at the destroyed transcript just the same.
  for (const pane of allLivePanes()) {
    setPaneState(pane, (p) =>
      p.resumeSessionId === session.id ? { resumeSessionId: null } : {},
    );
  }
  savePrefs();

  // `deleted: false` means it was already gone — the user's intent either way,
  // so it is not reported. See the protocol's `SessionsDeleteResponse`.
  return true;
}

/**
 * Is this session attached to a run that is still going — in any window?
 *
 * Asks the main process rather than reading local state, and that is the whole
 * reason this is async. The store's own `run` is only *this* window's; the run
 * registry holds every live run in the app, which is what "still running
 * somewhere" has to mean if the warning is to be trusted. A second window
 * working in the same session is exactly the case where deleting it silently
 * would be worst.
 *
 * Answers `false` when the question cannot be asked — no bridge, or a failed
 * call. A failure here must not block a delete the user asked for: the
 * confirmation they get is then the ordinary one, which is the same dialog
 * they would have seen if nothing were running.
 */
export async function isSessionRunning(sessionId: SessionId): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;

  // No `cwd` filter: a run in another project can still hold this session.
  const result = await call(() => bridge.runs.list({}));
  if (!result.ok) return false;

  return result.value.runs.some((run) => run.sessionId === sessionId && run.status !== 'ended');
}

/**
 * Are these two listings the same, as far as the sidebar is concerned?
 *
 * Compares the fields the list actually renders. A deep equality check would be
 * both slower and wrong — a session carries timestamps and counters that tick
 * without changing anything on screen.
 */
function sameSessions(a: readonly SessionSummary[], b: readonly SessionSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.id !== y.id ||
      x.title !== y.title ||
      x.updatedAt !== y.updatedAt ||
      x.cwd !== y.cwd ||
      x.profileId !== y.profileId
    ) {
      return false;
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* The live session feed                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How often the sidebar re-reads session history while a run is live.
 *
 * A run rewrites its session file as it goes — the title is generated partway
 * through, and the timestamp moves on every turn — so this is the window in
 * which the list is actually changing.
 */
const SESSION_POLL_LIVE_MS = 4_000;

/**
 * And while nothing is running.
 *
 * Not zero, because this window is not the only writer: a second Artemis window,
 * or the user's own `claude` in a terminal, writes into the same history that
 * this sidebar lists. Polling is what makes those appear without a reload.
 */
const SESSION_POLL_IDLE_MS = 20_000;

/**
 * How long after `run.end` to re-read.
 *
 * The provider writes its session file asynchronously, so a listing taken the
 * instant a run ends frequently reads the state from *before* the last turn —
 * the row appears with a stale title, or the brand-new session is missing
 * altogether. That was the bug this feed was built to fix: the list did update
 * on `run.end`, it just read too early, and nothing read again until the window
 * was reloaded. Waiting a beat and letting the poll cover the rest is more
 * robust than trying to guess when the file has landed.
 */
const SESSION_SETTLE_MS = 600;

/**
 * Start the sidebar's live feed. Returns an unsubscribe.
 *
 * Three triggers, deliberately overlapping — each covers a case the others
 * miss, and `refreshSessions` drops the duplicates:
 *
 *  - **A timer**, faster while a run is live. Catches this window's own
 *    in-progress writes and every other writer's.
 *  - **Window focus and tab visibility**, so returning to a window that has sat
 *    in the background never shows a stale list for as long as a poll interval.
 *  - **Lifecycle events**, from `handleAgentEvent`: a session starting, and a
 *    run ending.
 *
 * ## The poll deliberately does not check `document.visibilityState`
 *
 * Standing the timer down while the window is hidden is the obvious saving, and
 * it was written that way first. It is wrong here. The saving is one directory
 * listing every twenty seconds; the cost of a false "hidden" is that the feed
 * silently stops and the sidebar goes stale — which is the exact bug this
 * exists to fix. Electron reports occluded and minimised windows as hidden, and
 * a plain browser reports a background tab the same way, so the failure mode is
 * routine rather than exotic. Poll regardless and treat focus as an *extra*
 * trigger, not a gate.
 */
export function startSessionFeed(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    // Either column running is enough to poll fast: both are writing session
    // files, and the sidebar lists both.
    timer = setTimeout(tick, anyPaneLive() ? SESSION_POLL_LIVE_MS : SESSION_POLL_IDLE_MS);
  };

  const tick = (): void => {
    if (stopped) return;
    void refreshSessions();
    void refreshLiveWork();
    schedule();
  };

  const onWake = (): void => {
    if (stopped) return;
    void refreshSessions();
    void refreshLiveWork();
    schedule();
  };

  schedule();
  window.addEventListener('focus', onWake);
  document.addEventListener('visibilitychange', onWake);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    window.removeEventListener('focus', onWake);
    document.removeEventListener('visibilitychange', onWake);
  };
}

/**
 * Put delegated rows back onto the columns that have none.
 *
 * ## Why a poll has to do this at all
 *
 * Rows normally arrive on `background.tasks`, which is run-scoped: it is emitted
 * onto the turn being served and retained on that run's event stream. Neither
 * half survives a reload of a conversation whose work outlived its turn. ⌘R
 * empties every pane's `tasks`, and `attachRun` re-attaches to the run that is
 * live *now* — routinely a continuation whose retained events never mentioned the
 * workflow, because the turn that launched it ended long ago. `attachRun` has a
 * guard for this (`sameSession`), but a freshly loaded window has no previous
 * pane state for it to match on, so it can only ever decline to clear rows that
 * were already gone.
 *
 * The ledger on the provider process is the surviving copy, and this is where it
 * lands. The symptom without it: a live workflow shows as a disabled delegated
 * tab on a conversation that reads as finished, until the user sends a message
 * and the turn that opens announces the rows that were there the whole time.
 *
 * ## Restoring, never correcting
 *
 * A pane with rows *and* a live run is left alone. `background.tasks` is
 * authoritative while a turn is open and arrives several times a second; this
 * read is seconds behind it, and writing over live rows would replace them with
 * older ones and walk the list backwards on screen. Between turns there is no
 * competing writer — which is the whole reason this channel exists — so a column
 * whose run has ended takes the update and its rows settle without waiting for a
 * turn that may never come.
 *
 * Conversations the main process reported nothing for are not cleared here.
 * Absent means "no rows held", which is what a provider that cannot answer also
 * looks like; treating it as "delegated nothing" would empty a list on the
 * strength of a question nobody answered.
 */
function restoreDelegatedRows(delegated: readonly SessionDelegatedWork[]): void {
  if (delegated.length === 0) return;
  const app = useApp.getState();
  for (const entry of delegated) {
    const pane = paneForSession(entry.sessionId, app);
    if (pane === undefined) continue;
    const state = paneState(pane);
    if (state.tasks.length > 0 && isLive(state)) continue;
    // Compared before writing because this lands every few seconds for the whole
    // life of a workflow, and `setPaneState` wakes every subscriber to the
    // column — the delegated tab, the header count, the sidebar marker. Whole
    // rows rather than a chosen few fields: they nest (a workflow carries its
    // agents), and a comparison that reads only the top level would go quiet on
    // exactly the updates a workflow row exists to show.
    if (JSON.stringify(state.tasks) === JSON.stringify(entry.tasks)) continue;
    // The dismissal record is pruned against the incoming set exactly as the
    // event path prunes it, and for the same reason: it must only ever name rows
    // the provider is still reporting, or `showsTasks` is asking whether a row
    // that no longer exists was dismissed. Two writers of `tasks` that disagree
    // about that would make the delegated tab's return depend on which of them
    // last ran.
    const reported = new Set(entry.tasks.map((one) => one.id));
    const kept = state.dismissedTasks.filter((id) => reported.has(id));
    setPaneState(pane, {
      tasks: entry.tasks,
      ...(kept.length === state.dismissedTasks.length ? {} : { dismissedTasks: kept }),
    });
  }
}

/**
 * Re-read which conversations the main process is still working on.
 *
 * Rides the session feed's timer rather than owning one: it is wanted at exactly
 * the moments a listing is — on a tick, on focus, on returning to a window that
 * has sat in the background — and a second timer would be a second thing to
 * reason about for one in-memory read.
 *
 * ## Failure leaves the set alone
 *
 * A failed read keeps the previous answer instead of clearing it, and that
 * direction is chosen rather than incidental: this set only ever *widens* what
 * counts as working ({@link isWorking}), so a stale entry costs a pane held a
 * little longer than needed, while an empty one on a dropped call would put
 * every backgrounded workflow back in reach of `pruneBackground`. The engine
 * being briefly unavailable must not be the thing that decides a conversation is
 * over.
 *
 * Written only on a real change, for the reason {@link syncRunningSessions}
 * gives: this lands every few seconds and an unconditional write would re-render
 * every consumer of the store on each one.
 */
async function refreshLiveWork(): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const result = await call(() => bridge.runs.liveWork({}));
  if (!result.ok) return;

  // Before the comparison below, not after: that one returns early whenever the
  // *set of working sessions* has not moved, which is the ordinary case for a
  // window that reloaded while a workflow was already running. Rows restored on
  // the strength of an unrelated change would be rows restored by luck.
  restoreDelegatedRows(result.value.delegated);

  const next = result.value.sessionIds;
  const current = useApp.getState().sessionsHoldingWork;
  if (current.length === next.length && current.every((id, at) => id === next[at])) return;
  useApp.setState({ sessionsHoldingWork: next });
  // The marker is computed from this set as well as from the panes, and nothing
  // else will recompute it: the pane subscription that normally drives it fires
  // on pane writes, and this is a window write.
  syncRunningSessions();
}

/** Re-read history once the provider has had a moment to flush its own writes. */
function refreshSessionsSoon(): void {
  setTimeout(() => void refreshSessions(), SESSION_SETTLE_MS);
}

/**
 * Start a blank transcript in one column.
 *
 * ## Whatever was running keeps running
 *
 * A column that is working is not cleared — it is handed to
 * {@link AppState.background} and a blank one takes its place. Asking for a new
 * conversation says nothing about the old one, and an agent that is halfway
 * through editing files has no business being killed because the user wanted to
 * start something else while it finished. The sidebar goes on marking that
 * session as running and clicking it brings the column back.
 *
 * The caller gets the pane that now holds the column, which is a *different*
 * pane whenever a hand-off happened. Anything the caller does afterwards has to
 * be done to that one.
 *
 * ## A new session starts on the account with the most room
 *
 * When the polled readings can name a recommended profile (see
 * `planRecommendation`), the fresh session adopts it. This is the one moment
 * switching accounts is free: nothing has run, so no history is bound to the
 * profile yet, and the whole point of knowing which account has headroom is to
 * start the next piece of work there rather than discovering mid-session that
 * this one is nearly out. The profile chip on the status line updates in the
 * same frame, so which account the next prompt bills stays answerable at a
 * glance — the bar's standing rule.
 *
 * No recommendation — one account, stale readings, metered billing — changes
 * nothing: the session stays on the profile already selected.
 *
 * `adoptRecommendedProfile: false` is for callers where a new session is a
 * *side effect* rather than the request. `setCwd` resets the session because a
 * directory moved; hopping the billing account off the back of a workspace
 * action would move *who pays* when the user only asked to move *where* —
 * exactly the silent account change `resumeSession` refuses to make.
 */
export function newSession(
  pane: Pane = focusedPane(),
  { adoptRecommendedProfile = true }: { readonly adoptRecommendedProfile?: boolean } = {},
): Pane {
  // Before anything moves, for the reason `resumeSession` does the same: the
  // choice this column is set to belongs to the conversation being left, and a
  // new one made before its first run reported an id has had no key to be filed
  // under until now. See `rememberModelChoice`.
  rememberModelChoice(pane);

  // A working conversation moves aside intact; an idle one is simply cleared,
  // which avoids remounting the column — and the composer the user is typing in
  // — for what is, in that case, nothing more than an erase.
  // `isWorking`: the clear below wipes `tasks`, and between turns this window's
  // rows cannot say whether a workflow is still going. Handing off costs a
  // remount; clearing in place costs the rows and the tab they feed.
  let target = pane;
  if (isWorking(paneState(pane))) {
    target = handOffToBlank(pane);
  } else {
    pane.transcript.reset();
    // Before the patch below moves `resumeSessionId` out from under it: what
    // was half-written to the conversation being erased stays with that
    // conversation, and whatever was left in this column's last new session
    // comes back. See `swapDraft`.
    swapDraft(pane, UNSTARTED_DRAFT);
    // `tasks` too: the rows belong to the conversation being erased, and a
    // fresh session inheriting the old one's settled list would open with a
    // Delegated tab full of work it never asked for.
    setPaneState(pane, {
      run: null,
      resumeSessionId: null,
      rewindToMessageId: null,
      permissionQueue: [],
      tasks: [],
      dismissedTasks: [],
      tasksRequested: false,
      filesRequested: false,
      // A new conversation is exactly what a handoff was asking for, so the
      // latch comes off with everything else. Whether the account still has
      // room is a question for the next reading, not a state to inherit — and a
      // fresh session that opened already refusing prompts would be absurd.
      handoff: 'none',
    });
  }

  if (adoptRecommendedProfile) {
    // Read off the app store, where the poll writes: the readings are
    // window-wide facts about accounts, not column state.
    const { profiles, planUsageByProfile } = useApp.getState();
    const recommended = planRecommendation(profiles, planUsageByProfile, Date.now());
    if (recommended !== null && recommended.profileId !== paneState(target).activeProfileId) {
      // `applyProfile`, not `setProfile`: the session was reset two statements
      // ago, so the rule `setProfile` enforces — moving accounts starts a new
      // conversation — has already been satisfied by the caller. Going through
      // the gate would be this function asking itself for permission, and would
      // recurse the moment `seedBeside` carried a session id forward.
      const profile = profiles.find((p) => p.id === recommended.profileId);
      if (profile) applyProfile(target, profile);
    }
  }

  useApp.setState({ paletteOpen: false });
  return target;
}

/**
 * Resume a past session — including the profile and directory it belongs to.
 *
 * ## Why this switches three things and not one
 *
 * A session id is not portable. Claude stores transcripts under
 * `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<id>.jsonl`, so the id only
 * resolves under the *profile whose config directory it was written in* and
 * against the *directory it ran in*. Setting `resumeSessionId` alone and
 * leaving whatever profile and cwd happen to be selected would send the run at
 * a session the provider cannot find — a failure that surfaces as a confusing
 * provider error several seconds later, after the user has typed a prompt.
 *
 * So the selection moves to match the session: provider, profile, directory,
 * then the id. The transcript records that it happened, because silently
 * changing which account the next prompt bills is not acceptable — that is the
 * one thing the status line exists to keep answerable.
 *
 * When the session's profile no longer exists, nothing is switched and the
 * failure is reported. Resuming into a different profile's config directory
 * would not find the session anyway.
 *
 * ## Returning to something that is already open
 *
 * A session this window already holds is not resumed at all — see
 * {@link paneForSession}. A conversation the user walked away from mid-run is
 * handed back to the column exactly as it was: same run, same transcript, same
 * parked permission prompt. One that never left the screen is simply focused.
 * Neither reads history, because reading it would replay from the provider's
 * file a conversation that is already in memory — and, while a run is going,
 * still being appended to — so the two copies would interleave.
 */
export function resumeSession(session: SessionSummary, pane: Pane = focusedPane()): void {
  const state = paneState(pane);

  /*
   * Which account continues this conversation.
   *
   * Normally `session.profileId`, because a transcript lives in exactly one
   * profile's config directory and no other profile can reach it. When profiles
   * share a store — see `alsoInProfiles` — several can, and `profileId` is then
   * one of two very different things. The flag says which.
   *
   * **`profileIsUnknown` set** — the adapter had to put *some* id on the row and
   * used the first sharer. It is an arbitrary winner, not a fact about the
   * conversation, and switching the user onto it would change which account the
   * next prompt bills for no reason they could name. So an active profile that
   * can reach the session keeps it, and the common gesture — click a row while
   * working on an account that shares the store — resumes with nothing switched.
   *
   * **Flag absent** — `profileId` is an answer. Either the store has exactly one
   * reader, or the ledger recorded the account this session actually ran under
   * and `attributeSession` wrote it back. Both are facts, and the sidebar prints
   * this one on the row.
   *
   * Preferring the active profile over a *fact* is what made the bar disagree
   * with the row that was just clicked: the sidebar said "Claude 5x", the status
   * line went on saying "Claude 3x", and the next prompt billed 3x. The ledger
   * then recorded 3x as the owner, so the row's badge changed to match on the
   * following listing — a conversation that appeared to wander between accounts
   * on its own.
   *
   * Both symptoms scale with the number of sharing accounts, because the chance
   * that the account you are on is the one the row names falls as accounts are
   * added. At eight or ten profiles sharing one `~/.claude` it is the normal
   * case rather than the edge.
   */
  const attributed = session.profileIsUnknown !== true;
  const resumeProfileId =
    !attributed && state.activeProfileId !== null && canReachSession(session, state.activeProfileId)
      ? state.activeProfileId
      : session.profileId;

  const profile = state.profiles.find((p) => p.id === resumeProfileId);
  if (!profile) {
    pushBanner(
      'error',
      'That session’s profile no longer exists',
      'A session lives inside the profile that created it, so it cannot be resumed from another one.',
    );
    return;
  }

  // Before anything moves: what this column is set to belongs to the
  // conversation it is set *for*. The setters have already filed every choice
  // made while an id was known; this catches the one made before the first run
  // reported one. See `rememberModelChoice`.
  rememberModelChoice(pane);

  /*
   * Open somewhere already? Then this is a return, not a resume.
   *
   * A backgrounded conversation comes home to this column. One that is already
   * in a column is revealed rather than opened again: a second copy would leave
   * two panes carrying the same `resumeSessionId`, and a prompt sent from either
   * would start a run appending to a transcript file the other one owns. That is
   * the rule {@link openSessionBeside} has always applied to a dragged row, and
   * an ordinary click is not a different question.
   *
   * Includes the pane the user is already looking at, which is how clicking the
   * row of the conversation in front of them became a no-op rather than a way to
   * background their own live run.
   */
  const open = paneForSession(session.id);
  if (open !== undefined) {
    if (useApp.getState().background.some((p) => p.id === open.id)) handOver(pane, open);
    useApp.setState({ paletteOpen: false, focusedPaneId: open.id });
    savePrefs();
    return;
  }

  if (!activeCapabilities(state).resumeSession) {
    pushBanner(
      'warn',
      `${activeProviderLabel(state)} cannot resume a session`,
      'The session was left selected but the next prompt will start a fresh one.',
    );
  }

  const switchedProfile = state.activeProfileId !== resumeProfileId;
  const switchedCwd = state.cwd !== session.cwd;

  // Whatever this column was working on moves aside rather than being killed —
  // the same rule as `newSession`, for the same reason. `target` is the pane
  // that now holds the column and everything below is done to it.
  const target = isLive(state) ? handOffToBlank(pane) : pane;
  target.transcript.reset();
  // Same rule as `newSession`, and the same ordering requirement: the draft
  // belongs to the conversation it was typed at, so it is parked under that
  // conversation's id before `resumeSessionId` moves — and this session's own
  // half-written prompt, if it has one, comes back out. See `swapDraft`.
  swapDraft(target, session.id);
  setPaneState(target, {
    run: null,
    activeProviderId: session.providerId,
    activeProfileId: resumeProfileId,
    cwd: session.cwd,
    resumeSessionId: session.id,
    forkOnResume: false,
    rewindToMessageId: null,
    permissionQueue: [],
    tasks: [],
    dismissedTasks: [],
    tasksRequested: false,
    // Same rule as `setProvider`: a catalogue belongs to a provider, so
    // landing on a different one has to drop it rather than show the previous
    // provider's models under the new one's name.
    ...(state.activeProviderId === session.providerId ? {} : { models: [], modelsError: null }),
    // The model this conversation was last being run on, where it has ever said.
    // Spread last so it wins, and spread as a whole or not at all: half a choice
    // is a combination nobody picked. No entry leaves the column on what it was
    // using — see `AppState.modelBySession`.
    ...(recalledModelChoice(session.id) ?? {}),
  });
  // Opening a session is a deliberate act on one column, so that column takes
  // the focus — which is what makes ⌘K, the run inspector and settings point
  // at what the user just opened rather than at whatever they last clicked.
  useApp.setState({ paletteOpen: false, focusedPaneId: target.id });
  // Recorded here for the same reason `refreshWorkspace` is: this function
  // writes `cwd` without going through `setCwd`, so everything hanging off a
  // directory change has to be done by hand. Continuing yesterday's session in
  // another project is exactly the trip the folder menu exists to save — and
  // the one that most often names a scratch checkout, which `rememberFolder`
  // declines.
  rememberFolder(session.cwd);
  savePrefs();

  const moved = [
    switchedProfile ? `profile → ${profile.label}` : '',
    switchedCwd ? `directory → ${session.cwd}` : '',
  ].filter(Boolean);

  if (moved.length > 0) {
    /*
     * Why the account moved, in the words that are true of *this* resume.
     *
     * An attributed session names the account it ran under, so that is the
     * reason and it is the same sentence the sidebar's badge is making. An
     * unattributed one moved only because the account in use cannot read the
     * store at all — nothing recorded who ran it, so claiming otherwise here
     * would be the guess the whole attribution path exists to refuse.
     */
    const because = [
      switchedProfile
        ? attributed
          ? 'under the account it last ran on'
          : 'under a profile that can reach it'
        : '',
      switchedCwd ? 'in the directory it was created in' : '',
    ]
      .filter(Boolean)
      .join(', ');

    target.transcript.note(
      'info',
      `Continuing "${session.title}"`,
      `Switched ${moved.join(' and ')}, because a session resumes ${because}.`,
    );
  }

  void loadSessionHistory(session, target);
  invalidateSessions();
  void refreshSessions();
  void refreshModels(target);
  refreshAuth(target);
  // This function writes `cwd` itself rather than going through `setCwd`, and
  // must keep doing so: `setCwd` clears `resumeSessionId` on the way past,
  // which is the one piece of state this function exists to set. Routing this
  // through it would resume a session and immediately un-resume it.
  //
  // The cost of writing the field directly is that the workspace read attached
  // to `setCwd` does not happen either, so it is done here — otherwise resuming
  // a session from another project leaves the previous project's name sitting
  // over the new project's sessions.
  if (switchedCwd) void refreshWorkspace(target);
}

/**
 * Open a session in a *new* pane beside or below an existing one.
 *
 * The action behind dropping a row from the sidebar onto a pane's edge, and
 * behind "Open beside" in the palette. It is {@link splitPane} followed by
 * {@link resumeSession} into what came back — written as one function because
 * the two must not be separable: splitting and then failing to load leaves an
 * empty pane the user did not ask for, and every caller wants exactly this
 * pair.
 *
 * If the session is already open somewhere, this is a *reveal*, not a second
 * copy. Two panes resumed at the same session id would be two provider
 * processes appending to one transcript file, which is a data race with the
 * user's own history on the losing side.
 *
 * `null` means the grid had no room in that direction; the caller has already
 * been told by {@link canSplit} and should not reach this.
 */
export function openSessionBeside(
  session: SessionSummary,
  direction: SplitDirection = 'right',
  from: Pane = focusedPane(),
): Pane | null {
  // Only a conversation that already has a column is a reveal. One that is
  // running in the background has nowhere to be revealed *to*, so it takes the
  // new column — `resumeSession` hands it over into the pane split below.
  const existing = paneForSession(session.id);
  if (existing !== undefined && allPanes().some((p) => p.id === existing.id)) {
    focusPane(existing.id);
    return existing;
  }

  const pane = splitPane(direction, from);
  if (!pane) return null;
  resumeSession(session, pane);
  // Not `pane`: a conversation that was running in the background comes home
  // *into* the new column, which replaces the pane split above with the one that
  // was already holding the run. `resumeSession` focuses whichever it landed in,
  // so this is the column the caller was asking for either way.
  return focusedPane();
}

/**
 * Replay a stored session into the transcript.
 *
 * History goes through `transcript.apply` — the *same* entry point the live
 * `agentEvent` push uses. That is the whole design: one rendering pipeline, so
 * a replayed tool call collapses, expands and diffs exactly like a live one and
 * no component has to know which it is drawing.
 *
 * Replayed events are stamped with a synthetic run id rather than a real one.
 * There is no run yet — resuming selects a session, it does not start work —
 * but the transcript keys on `runId`, and reusing the id of a *later* run would
 * make history indistinguishable from that run's own output. Deriving it from
 * the session id keeps the block stable across re-selection.
 */
async function loadSessionHistory(session: SessionSummary, pane: Pane): Promise<void> {
  const { bridge } = resolveBridge();
  if (!bridge) return;

  const runId = `history:${session.id}` as RunId;

  const res = await call(() =>
    bridge.sessions.messages({
      profileId: session.profileId,
      sessionId: session.id,
      runId,
      cwd: session.cwd,
    }),
  );

  // Selection can move while this is in flight — a fast second click, or a new
  // session. Applying a stale transcript over the current one would show the
  // wrong conversation, so drop it. Checked against *this column*: the other
  // one moving on is not this transcript's business.
  if (paneState(pane).resumeSessionId !== session.id) return;

  if (!res.ok) {
    // Non-fatal: the session still resumes, the user just cannot see what came
    // before. Say so rather than leaving an unexplained empty pane.
    pane.transcript.note(
      'warn',
      'Could not load earlier messages',
      `${res.error.message} The session will still continue from where it left off.`,
    );
    return;
  }

  for (const event of res.value.events) pane.transcript.apply(event);

  if (res.value.hasMore) {
    pane.transcript.note('info', 'Showing the most recent part of this session', undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

/** How many prompts Up-arrow can walk back through. */
const MAX_PROMPT_HISTORY = 100;

/** Append to the recall history, collapsing an immediate repeat. */
function rememberPrompt(prompt: string, pane: Pane): void {
  setPaneState(pane, (s) => {
    if (s.promptHistory[s.promptHistory.length - 1] === prompt) return {};
    return { promptHistory: [...s.promptHistory, prompt].slice(-MAX_PROMPT_HISTORY) };
  });
}

const STATUS_RANK: Record<RunStatus, number> = {
  starting: 0,
  running: 1,
  awaiting_permission: 1,
  ended: 2,
};

/**
 * Send a prompt, in one pane.
 *
 * Returns **false when the composer still owns the prompt** — when this refused
 * before anything was written to the transcript, so nothing anywhere is
 * displaying what the user typed. The composer keeps the attachments in that
 * case, because unlike the text they have no Up-arrow recall behind them: a
 * screenshot cleared out of the field on a "set a working directory" error is
 * gone, and taking it again is a trip out of the app.
 *
 * True once the message is in the transcript, including when the delivery then
 * fails: the prompt is on screen, the failure has a banner, and the record of
 * what was attached to it belongs with the message rather than back in an empty
 * composer.
 *
 * `pane` is last and defaults to the focused one, as every session-scoped
 * action here does. A composer always passes its own: it must send into the
 * conversation it is attached to, not into whichever one happens to have focus
 * when the user hits Enter.
 */
export async function submitPrompt(
  text: string,
  attachments?: readonly Attachment[],
  pane: Pane = focusedPane(),
): Promise<boolean> {
  const prompt = text.trim();
  if (prompt.length === 0) return false;

  // Recorded before anything can refuse the send — the guards below included.
  // Up-arrow recall is about getting a prompt back, and the prompt you most
  // want back is the one that just failed to go anywhere; the composer has
  // already cleared its field by the time any of these banners appear.
  rememberPrompt(prompt, pane);

  const { bridge } = resolveBridge();
  const state = paneState(pane);
  if (!bridge) {
    pushBanner('error', 'No bridge to the main process', 'The preload script did not load.');
    return false;
  }
  if (!state.activeProfileId) {
    pushBanner('error', 'Pick a profile first', 'A run needs credentials, which come from a profile.');
    setScreen('profiles');
    return false;
  }
  if (state.cwd.trim().length === 0) {
    pushBanner('error', 'Set a working directory', 'The agent needs an absolute path to work in.');
    return false;
  }
  /*
   * The stop that automatic handoff exists to perform.
   *
   * `done` means the document has been written, and carrying on here would
   * spend the runway it was bought with — which is the whole failure the
   * feature is meant to prevent, arrived at one prompt later. So the turn is
   * refused and the way out is named in the same breath.
   *
   * Returns false: nothing was written to the transcript, so the composer keeps
   * the prompt and its attachments and one dismissal is enough to send it.
   */
  if (state.handoff === 'done') {
    pushBanner('warn', 'This conversation has been handed over', HANDOFF_BLOCK_DETAIL);
    return false;
  }

  const live = isLive(state) ? state.run : null;

  // Filtered against the capabilities of the run that will actually carry them
  // — the *live* run mid-steer, the active provider otherwise. Those differ
  // after a provider switch mid-run, and the wrong one would either drop a
  // supported attachment or send one into a run that will refuse it.
  //
  // Per kind, because a provider can plausibly take one and not the other, and
  // dropping the whole set because half of it is unsupported would lose files
  // the run could have carried.
  const filterFor = (carrier: Capabilities): readonly Attachment[] | undefined => {
    const kept = (attachments ?? []).filter((attachment) =>
      attachment.kind === 'image' ? carrier.imageInput : carrier.fileInput,
    );
    return kept.length > 0 ? kept : undefined;
  };

  /**
   * The message, if it is already in the transcript when the new-run path
   * starts. Set only by the steer path below, when the run it was steering
   * turned out to have ended: the prompt is on screen already and pushing a
   * second copy would show the user their own words twice.
   */
  let carriedOver: string | null = null;

  if (live) {
    if (!live.capabilities.midRunSteering) {
      pushBanner('warn', 'This provider cannot take input mid-run');
      return false;
    }
    const steering = filterFor(live.capabilities);
    const steerId = pane.transcript.pushUserMessage(prompt, steering);
    const result = await call(() =>
      bridge.runs.send({
        runId: live.runId,
        text: prompt,
        ...(steering === undefined ? {} : { attachments: steering }),
      }),
    );
    if (result.ok) {
      pane.transcript.confirmUserMessage(steerId);
      if (!result.value.deliveredImmediately) {
        pane.transcript.note(
          'info',
          'Queued — the provider decides when this takes effect.',
          'It steers the current turn if the provider can fold it in, and otherwise waits for the next one.',
        );
      }
      return true;
    }

    /*
     * The run ended between the keystroke and the call landing.
     *
     * This is a race and not a mistake — `isLive` reads this window's copy of
     * the run, which main has already retired — and the engine forgives the
     * same race on `interrupt` for the same reason. Reporting it put a red
     * banner under a message the user then had to type again, which is the
     * worst of both: the send failed *and* the prompt was gone.
     *
     * So it falls through to the path it would have taken had the state
     * arrived a moment earlier, carrying the message already on screen rather
     * than pushing a second copy of it. Every other failure is still a failure.
     */
    if (!isEndedRunError(result.error)) {
      reportFailure('Could not deliver the message', result.error);
      // True: the message is in the transcript, dimmed, with its attachments. See
      // the note on this function for why that counts as sent from here.
      return true;
    }
    carriedOver = steerId;
    /*
     * Draw the ending main already performed — but only if it is still missing.
     *
     * The `run.end` for this run may have arrived while the send was in flight,
     * in which case the transcript has its card and the pane is already settled;
     * `localRunEnd` inserts unconditionally, so calling it anyway would show the
     * turn ending twice. And it may never arrive: the new run replaces
     * `state.run` a few lines below, after which `paneForRun` no longer resolves
     * the old id and a straggling `run.end` is dropped. Between those two is the
     * one case that needs this.
     */
    if (paneState(pane).run?.runId === live.runId && isLive(paneState(pane))) {
      endRunLocally(live.runId, 'completed', pane);
    }
  }

  const runId = newId('run');
  const capabilities = activeCapabilities(state);
  // Re-filtered: the fallback above crosses from the live run's capabilities to
  // the active provider's, and after a mid-run provider switch those differ.
  const sending = filterFor(capabilities);
  const promptId = carriedOver ?? pane.transcript.pushUserMessage(prompt, sending);
  setPaneState(pane, {
    run: {
      runId,
      status: 'starting',
      providerId: state.activeProviderId,
      profileId: state.activeProfileId,
      cwd: state.cwd,
      capabilities,
      startedAt: Date.now(),
      permissionMode: state.permissionMode,
    },
    permissionQueue: [],
    // Not `tasks`. A subagent launched last turn is still running as this one
    // starts — that is the ordinary case now — and the next `background.tasks`
    // replaces the set anyway.
  });

  // Both are sent only when the *live descriptor* still offers them. A stored
  // preference outlives a provider switch, and forwarding one the provider has
  // never heard of would either be rejected outright or — worse — accepted and
  // ignored, leaving the status line claiming a setting the run did not use.
  const model = activeModel(state);
  const effort = activeEffort(state);

  // The same rule one level down, applied per *model* rather than per provider.
  // `fastMode` and `ultracode` are persisted standing preferences, so either can
  // be on while the currently selected model does not accept it — and a model
  // that does not accept a flag ignores it silently rather than rejecting it.
  // Sending one anyway is precisely the failure `fastModeAvailable` /
  // `ultracodeAvailable` exist to keep off the screen, so the send is gated on
  // the same fact the toggles are. When a model *does* support the flag the
  // value is forwarded either way, including `false`: with the toggle visible,
  // off is a choice the user made, not an absence of one.
  const supportsFast = model?.supportsFastMode === true;
  const supportsUltra = model?.supportsUltracode === true;

  const input: RunInput = {
    providerId: state.activeProviderId,
    profileId: state.activeProfileId,
    cwd: state.cwd,
    prompt,
    runId,
    includePartialMessages: capabilities.partialMessages,
    ...(sending === undefined ? {} : { attachments: sending }),
    ...(model ? { model: model.id } : {}),
    ...(effort ? { effort: effort.id } : {}),
    ...(supportsFast ? { fastMode: state.fastMode } : {}),
    ...(supportsUltra ? { ultracode: state.ultracode } : {}),
    ...(capabilities.permissionModes.includes(state.permissionMode)
      ? { permissionMode: state.permissionMode }
      : {}),
    ...(state.resumeSessionId && capabilities.resumeSession
      ? {
          resumeSessionId: state.resumeSessionId,
          ...(state.forkOnResume && capabilities.forkSession ? { forkSession: true } : {}),
          ...(state.rewindToMessageId !== null && capabilities.rewind
            ? { rewindToMessageId: state.rewindToMessageId }
            : {}),
        }
      : {}),
  };

  // One-shot, like `forkOnResume` after a fork lands: the truncation happens on
  // the run this prompt starts, and the prompt after that continues whatever
  // the rewound conversation became. Cleared before the round-trip rather than
  // after it so a failed start does not leave a stale rewind aimed at the next
  // unrelated prompt.
  if (state.rewindToMessageId !== null) {
    setPaneState(pane, { rewindToMessageId: null });
  }

  const result = await call(() => bridge.runs.start({ input }));
  if (!result.ok) {
    reportFailure('Could not start the run', result.error);
    endRunLocally(runId, 'error', pane, result.error);
    // As above: the prompt and its attachments are in the transcript, so the
    // composer is right to have let go of them.
    return true;
  }
  pane.transcript.confirmUserMessage(promptId);
  mergeHandle(result.value.run, pane);
  return true;
}

function mergeHandle(handle: RunHandle, pane: Pane): void {
  setPaneState(pane, (s) => {
    if (!s.run || s.run.runId !== handle.runId) return {};
    const status =
      STATUS_RANK[s.run.status] >= STATUS_RANK[handle.status] ? s.run.status : handle.status;
    return {
      run: {
        ...s.run,
        status,
        capabilities: handle.capabilities,
        startedAt: handle.startedAt,
        sessionId: s.run.sessionId ?? handle.sessionId,
      },
    };
  });
}

/**
 * End a run the main process never accepted.
 *
 * `run.end` is contractually always emitted — but only for runs that actually
 * started. When `runs.start` itself fails there is no stream to carry one, and
 * the UI would otherwise sit at `starting` forever, so the terminal card is
 * written locally instead of faking an event with an invented `seq`.
 */
function endRunLocally(
  runId: RunId,
  reason: RunEndReason,
  pane: Pane,
  error?: AgentError,
): void {
  setPaneState(pane, (s) =>
    s.run && s.run.runId === runId
      ? { run: { ...s.run, status: 'ended', endReason: reason, ...(error ? { error } : {}) } }
      : {},
  );
  pane.transcript.localRunEnd(reason, error);
}

/*
 * The transport can drop events, and one of the droppable events is `run.end`.
 *
 * The transcript notes a `seq` gap and carries on, which is the right answer
 * for text — the next flush corrects the screen. It is the wrong answer when
 * the hole swallowed the run's terminal event: nothing else ever says "this
 * ended", so the pane stays live forever — composer locked on Stop, session
 * feed pinned to its fast poll, sidebar light on. So a detected drop asks the
 * main process one question — is this run still in the registry? — and a run
 * that is gone is settled through the same local-end path a failed start takes.
 *
 * One reconcile per drop burst: gaps arrive in clusters, every one of them
 * asking the same question about the same run, and the set below holds the
 * run's id for as long as one answer is in flight.
 */
const dropReconciles = new Set<RunId>();

function reconcileDroppedRun(runId: RunId): void {
  if (dropReconciles.has(runId)) return;

  const pane = paneForRun(runId);
  if (!pane) return;
  if (paneState(pane).run?.status === 'ended') return;

  dropReconciles.add(runId);
  void (async () => {
    try {
      const { bridge } = resolveBridge();
      if (!bridge) return;
      const listed = await call(() => bridge.runs.list({}));
      if (!listed.ok) return;
      // Still in the registry and still going: whatever the gap swallowed, it
      // was not this run's end, and the stream corrects itself from here.
      if (listed.value.runs.some((h) => h.runId === runId && h.status !== 'ended')) return;
      // The real `run.end` may have landed while the list was in flight, and a
      // second terminal card on top of it would say the run ended twice.
      const current = paneState(pane).run;
      if (!current || current.runId !== runId || current.status === 'ended') return;
      // The registry retires a run when it ends, so "not in the list" means the
      // provider finished — what the drop cost is only *how*. `completed` is
      // the least-wrong reading, and the dropped-events note the transcript has
      // already printed sits right above this card saying why it is a reading.
      endRunLocally(runId, 'completed', pane);
    } finally {
      dropReconciles.delete(runId);
    }
  })();
}

// At module scope because the transcript is live from the first pane onwards —
// a hook registered at bootstrap would miss nothing in practice, but there is
// no reason to leave the gap.
setEventsDroppedHook(reconcileDroppedRun);

export async function interruptRun(pane: Pane = focusedPane()): Promise<void> {
  const { bridge } = resolveBridge();
  const run = paneState(pane).run;
  if (!bridge || !run || run.status === 'ended') return;
  const result = await call(() => bridge.runs.interrupt({ runId: run.runId }));
  if (!result.ok) {
    reportFailure('Could not interrupt the run', result.error);
    return;
  }
  const queued = result.value.stillQueued ?? [];
  if (queued.length > 0) {
    pane.transcript.note('warn', `${queued.length} queued message(s) will still run.`);
  }
}

/**
 * How much delegated work a column is holding, and how much of it is live.
 *
 * Two selectors returning numbers rather than one returning a summary object,
 * and that is a rule about zustand rather than a style choice: a selector that
 * builds an object returns a new identity on every call, so the default equality
 * check never matches and the component re-renders itself forever. The label the
 * tab shows is assembled from these two numbers where it is drawn.
 */
export function taskCount(state: AppState, paneId: PaneId): number {
  const pane = allLivePanes(state).find((one) => one.id === paneId);
  return pane === undefined ? 0 : paneState(pane).tasks.length;
}

/**
 * The count that goes on the tab.
 *
 * Live work, not total: a tab reading "3" over three finished rows would be the
 * same past-tense lie the transcript already tells with "delegated to 3 agents"
 * while they are still working.
 */
export function liveTaskCount(state: AppState, paneId: PaneId): number {
  const pane = allLivePanes(state).find((one) => one.id === paneId);
  if (pane === undefined) return 0;
  let live = 0;
  for (const task of paneState(pane).tasks) if (isTaskLive(task)) live += 1;
  return live;
}

/**
 * Ask the provider to stop one delegated task.
 *
 * Addressed through the pane's run, which is how the main process finds the
 * provider process holding it — and deliberately not gated on that run being
 * live. A task worth stopping is one that outlived the turn that launched it, so
 * the run named here has usually ended, and refusing on that basis would refuse
 * every stop worth making.
 *
 * Nothing is written optimistically. The row settles when the provider says it
 * has, through the same `background.tasks` event a natural finish arrives on, so
 * a stop that silently failed looks different from one that worked — which is
 * the whole reason to wait.
 *
 * The pane is **required**, breaking the house convention of defaulting to
 * {@link focusedPane} — deliberately. The only surface that offers a stop is the
 * dock's delegated tab, which names the column it belongs to, and clicking a
 * dock tab never moves pane focus. So in a split the focused pane is precisely
 * the wrong guess: a stop pressed in the right column's task list would be
 * routed through the left column's run, and either interrupt a stranger's task
 * or find no task at all and silently do nothing. There is no caller for whom
 * "whichever column has focus" is the right answer, so the signature refuses to
 * offer it.
 */
export async function stopTask(taskId: string, pane: Pane): Promise<void> {
  const { bridge } = resolveBridge();
  const run = paneState(pane).run;
  if (!bridge || !run) return;

  const result = await call(() => bridge.runs.stopTask({ runId: run.runId, taskId }));
  if (!result.ok) reportFailure('Could not stop the task', result.error);
}

/*
 * REMOVED: `disposeRun`.
 *
 * It had three callers — `newSession`, `resumeSession` and `closePane` — and in
 * every one of them it was the bug: leaving a conversation is a statement about
 * what the user wants to look at, and it was killing the agent's subprocess
 * mid-edit. Those three now hand the pane to `AppState.background` instead.
 *
 * Nothing replaced it, deliberately. A run ends when it finishes, when
 * {@link interruptRun} stops it, or when the app quits (`engine.dispose`), and
 * the registry retires each one on `run.end` — so there is no resource here
 * that needed a fourth way to be released, and re-adding one would re-open the
 * question of which navigation is allowed to kill work.
 */

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/** Take one request off the queue, clearing `awaiting_permission` when it empties. */
function dropPermissionRequest(requestId: string, pane: Pane): void {
  setPaneState(pane, (s) => {
    const permissionQueue = s.permissionQueue.filter((r) => r.id !== requestId);
    const run =
      s.run && s.run.status === 'awaiting_permission' && permissionQueue.length === 0
        ? { ...s.run, status: 'running' as RunStatus }
        : s.run;
    return { permissionQueue, run };
  });
}

/**
 * Answer a parked request — an approval or a question.
 *
 * @returns `null` when the decision landed, or a sentence describing why it did
 *          not. The caller renders that sentence *on the prompt itself*. This
 *          is the main reason the prompt is inline in the transcript rather
 *          than a modal: a decision that fails to send has to be reported where
 *          the user is looking, and a toast or a banner behind an overlay is
 *          invisible — leaving the user staring at a card that appeared to do
 *          nothing while a parked run waits forever.
 */
export async function respondToPermission(
  requestId: string,
  decision: PermissionDecision,
  pane: Pane = focusedPane(),
): Promise<string | null> {
  const { bridge } = resolveBridge();
  const run = paneState(pane).run;
  if (!bridge || !run) return null;

  // Read before the await: the queue is emptied on the way out, and the record
  // written afterwards still has to know which kind of card it is settling.
  const isQuestion =
    paneState(pane).permissionQueue.find((r) => r.id === requestId)?.question !== undefined;
  const isPlan =
    paneState(pane).permissionQueue.find((r) => r.id === requestId)?.plan !== undefined;

  const result = await call(() =>
    bridge.runs.respondToPermission({ runId: run.runId, requestId, decision }),
  );
  if (!result.ok) {
    reportFailure('Could not send the decision', result.error);
    // `invalid_request` means the request is gone for good: the provider
    // withdrew it and answered it itself. Retrying can only fail the same way,
    // so keeping it queued would hold the modal open — over the transcript, the
    // composer and the Stop button — until the run happened to end on its own.
    // Drop it instead, and record on the card that the choice was taken away.
    if (result.error.code === 'invalid_request') {
      pane.transcript.resolvePermission(requestId, 'denied', result.error.message);
      dropPermissionRequest(requestId, pane);
    }
    return result.error.message;
  }

  const record = recordFor(decision, isQuestion, isPlan);
  pane.transcript.resolvePermission(
    requestId,
    record.state,
    record.note,
    decision.behavior === 'allow' ? decision.answers : undefined,
  );

  if (isPlan && decision.behavior === 'allow') leavePlanMode(decision, pane);

  dropPermissionRequest(requestId, pane);
  return null;
}

/**
 * Stop the column claiming it is still planning.
 *
 * An approved plan means the agent is about to start work, and the provider
 * ends plan mode by running the tool at all. The picker in the status line is a
 * separate thing — a stored preference this column sends at the *start* of a
 * run — so nothing has told it any of that happened. Left alone it goes on
 * reading `plan`, and the next prompt would be sent in plan mode: the user
 * approves a plan, asks the agent to get on with it, and watches it refuse to
 * edit anything.
 *
 * Which mode to move to is the provider's call, not this app's, and the
 * provider states it in the `setMode` update attached to the request — echoed
 * back by the plan card and read here. `default` is the fallback for a provider
 * that offered nothing: it is the mode that asks, which is the safe direction to
 * guess in, and the picker is one click away for a user who wants otherwise.
 */
function leavePlanMode(decision: AllowPermissionDecision, pane: Pane): void {
  if (paneState(pane).permissionMode !== 'plan') return;
  const setMode = (decision.updatedPermissions ?? []).find((update) => update.type === 'setMode');
  setPermissionMode(setMode?.mode ?? 'default', pane);
}

/**
 * How a settled request reads in the transcript.
 *
 * A question's outcomes are not an approval's. Both leave through `allow`, but
 * "allowed once" is meaningless for an interview and "denied" overstates a
 * shrug — so the record says `answered` or `skipped`, and reserves the
 * permission vocabulary for the requests that are actually about permission.
 *
 * A plan is the third case, and it only needs the scope note dropped. "Allowed
 * once" is true of an approved plan and says nothing: a plan is proposed once
 * and answered once, so there was never a second scope it could have had.
 */
function recordFor(
  decision: PermissionDecision,
  isQuestion: boolean,
  isPlan = false,
): { state: Exclude<PermissionItem['state'], 'pending'>; note: string | undefined } {
  if (decision.behavior === 'deny') return { state: 'denied', note: decision.message };
  if (isPlan) return { state: 'allowed', note: undefined };
  if (!isQuestion) return { state: 'allowed', note: describeScope(decision.scope) };
  const answered = (decision.answers ?? []).some(
    (a) => a.options.length > 0 || (a.notes?.trim().length ?? 0) > 0,
  );
  return answered
    ? { state: 'answered', note: undefined }
    : { state: 'skipped', note: 'Left unanswered. The agent was told to use its own judgement.' };
}

/** Neutral denial handed back to the model when the user gives no reason. */
export const DEFAULT_DENIAL = 'The user denied this tool call.';

/**
 * Resolve the oldest outstanding prompt the safe way.
 *
 * Bound to Escape, which therefore resolves a parked request while one exists
 * and interrupts the run otherwise. Escape *has* to settle it: the provider is
 * blocked with no deadline, so the reflex that means "get this off my screen"
 * must unblock the run rather than strand it.
 *
 * What "safe" means depends on what is parked. For an approval it is a denial
 * — the tool does not run. For a question there is nothing to refuse, and a
 * denial would hand the model a rejection it never asked for; the safe answer
 * is to skip, which tells it the questions went unanswered and lets it carry on
 * using its own judgement.
 *
 * @returns true when there was something to resolve.
 */
export async function denyPendingPermission(pane: Pane = focusedPane()): Promise<boolean> {
  const request = pendingPermission(paneState(pane));
  if (!request) return false;
  const decision: PermissionDecision = request.question
    ? { behavior: 'allow', answers: [] }
    : { behavior: 'deny', message: DEFAULT_DENIAL };
  await respondToPermission(request.id, decision, pane);
  return true;
}

function describeScope(scope: PermissionScope | undefined): string {
  switch (scope) {
    case 'session':
      return 'Allowed for this session';
    case 'local':
      return 'Allowed for this project (local)';
    case 'project':
      return 'Allowed for this project';
    case 'user':
      return 'Allowed everywhere';
    default:
      return 'Allowed once';
  }
}

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Create a profile.
 *
 * The profile is created signed out — that is the normal first state. The
 * caller is expected to send the user to the sign-in step next; see
 * `ProfilesScreen`.
 */
export async function createProfile(draft: ProfileDraft): Promise<ProfileId | null> {
  const { bridge } = resolveBridge();
  if (!bridge) return null;
  const result = await call(() => bridge.profiles.create({ draft }));
  if (!result.ok) {
    reportFailure('Could not create the profile', result.error);
    return null;
  }
  await refreshProfiles();

  /*
   * The new profile becomes the active one, and the app follows it to its
   * provider.
   *
   * Those two have to move together. A profile belongs to exactly one CLI, so
   * making a Codex profile active while `activeProviderId` still says `claude`
   * asks the Claude adapter to answer for an account it has never heard of —
   * every catalogue fetch, session list and run would go to the wrong binary.
   * It could not happen while the create form silently used the active provider;
   * it can now that the form asks.
   */
  const created = result.value.profile;
  // The focused column adopts it. Creating an account is something you do from
  // one conversation, and quietly repointing the *other* column at a brand-new
  // signed-out profile would change what its next prompt bills.
  const pane = focusedPane();

  /*
   * Unless that column is holding a conversation — then nothing moves.
   *
   * This is the same rule `setProfile` enforces, arriving by a different door.
   * A session id resolves only under the config directory it was written in, so
   * repointing a column that has one at a brand-new profile is the cross-account
   * resume that function now refuses; and it would be worse here, because the
   * new account is signed out, so the next prompt would fail on credentials
   * against a transcript it could not have read anyway.
   *
   * Not routed *through* `setProfile`, which would end the conversation to make
   * room. Creating an account is account admin — a request about the app's
   * accounts, not about the conversation on screen — so the honest response is
   * to leave the conversation alone and say the account is there when they want
   * it. First run, where adoption actually matters, has no session to protect
   * and still adopts.
   */
  const holdingASession =
    paneState(pane).resumeSessionId !== null || paneState(pane).run !== null;
  if (holdingASession) {
    pushBanner(
      'info',
      `${created.label} is ready to use`,
      'It was not made active, because this conversation belongs to the account it started on. Start a new session to work on the new account.',
    );
    return created.id;
  }

  const switched = paneState(pane).activeProviderId !== created.providerId;
  setPaneState(pane, {
    activeProfileId: created.id,
    activeProviderId: created.providerId,
    // Cleared on a provider change for the reason `setProvider` gives: a
    // catalogue and a session list both belong to the provider they came from.
    ...(switched ? { models: [], modelsError: null } : {}),
  });
  savePrefs();
  if (switched) {
    useApp.setState({ sessions: [] });
    invalidateSessions();
    void refreshSessions();
  }
  // A new profile is a new account, and the catalogue is a property of the
  // account — the freshly created one may well be the first that can answer at
  // all, since `refreshModels` no-ops without a profile.
  void refreshModels(pane);
  return created.id;
}

export async function updateProfile(id: ProfileId, patch: ProfilePatch): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;
  const result = await call(() => bridge.profiles.update({ id, patch }));
  if (!result.ok) {
    reportFailure('Could not update the profile', result.error);
    return false;
  }
  await refreshProfiles();
  return true;
}

export async function deleteProfile(id: ProfileId, deleteConfigDir: boolean): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;
  const result = await call(() => bridge.profiles.remove({ id, deleteConfigDir }));
  if (!result.ok) {
    reportFailure('Could not delete the profile', result.error);
    return false;
  }
  // `configDirDeleted` can be false even when it was asked for: the main
  // process refuses to delete a directory Artemis did not create. Reporting
  // what actually happened matters more here than usual — the user may have
  // expected their `~/.claude` to be gone, and it is not.
  if (deleteConfigDir && !result.value.configDirDeleted) {
    pushBanner('info', 'Profile deleted. Its config directory was left alone — Artemis only deletes directories it created.');
  } else if (result.value.configDirDeleted) {
    pushBanner('info', 'Profile and its session history were deleted');
  }
  await refreshProfiles();
  return true;
}

/**
 * A config-directory path to prefill the create form with.
 *
 * Returns `null` when the main process cannot answer, which the form treats as
 * "leave the field empty" rather than as an error worth a banner — the user can
 * still choose a directory, which is the point of the field.
 */
export async function suggestConfigDir(label: string): Promise<string | null> {
  const { bridge } = resolveBridge();
  if (!bridge) return null;
  const result = await call(() => bridge.profiles.suggestDir({ label }));
  return result.ok ? result.value.configDir : null;
}

/**
 * Read a profile's login state, plus the command that would change it.
 *
 * Deliberately silent on failure: this is polled while the user signs in, and a
 * banner per poll would bury the screen. The status itself carries an `error`
 * field for the cases worth showing, and the screen renders that inline.
 */
export async function readAuthStatus(
  profileId: ProfileId,
): Promise<{ readonly status: AuthStatusInfo; readonly signInCommand: string } | null> {
  const { bridge } = resolveBridge();
  if (!bridge) return null;
  const result = await call(() => bridge.auth.status({ profileId }));
  if (!result.ok) return null;
  useApp.setState((s) => ({
    authByProfile: { ...s.authByProfile, [profileId]: result.value.status },
  }));
  return result.value;
}

/**
 * Clear the credential in a profile's config directory.
 *
 * Writes the resulting status into the cache, because nothing else will: the
 * cards poll on mount and while a sign-in is in progress, so a sign-out whose
 * result was dropped would leave every reader showing "signed in" until
 * something unrelated happened to re-read it.
 */
export async function signOutProfile(profileId: ProfileId): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;
  const result = await call(() => bridge.auth.signOut({ profileId }));
  if (!result.ok) {
    reportFailure('Could not sign the profile out', result.error);
    return false;
  }
  useApp.setState((s) => ({
    authByProfile: { ...s.authByProfile, [profileId]: result.value.status },
  }));
  return true;
}

/* -------------------------------------------------------------------------- */
/* Event feed                                                                 */
/* -------------------------------------------------------------------------- */

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(sum(a.cacheReadInputTokens, b.cacheReadInputTokens) === undefined
      ? {}
      : { cacheReadInputTokens: sum(a.cacheReadInputTokens, b.cacheReadInputTokens) }),
    ...(sum(a.cacheCreationInputTokens, b.cacheCreationInputTokens) === undefined
      ? {}
      : { cacheCreationInputTokens: sum(a.cacheCreationInputTokens, b.cacheCreationInputTokens) }),
    ...(sum(a.webSearchRequests, b.webSearchRequests) === undefined
      ? {}
      : { webSearchRequests: sum(a.webSearchRequests, b.webSearchRequests) }),
  };
}

/**
 * Fold a usage report into what is already on screen.
 *
 * `scope` is on the wire precisely so this function can exist: `delta` events
 * accumulate, `cumulative` and `final` replace. Guessing wrong shows the user
 * nonsense, so the scope is honoured rather than inferred.
 */
function mergeUsage(previous: UsageSnapshot | undefined, next: UsageSnapshot): UsageSnapshot {
  if (next.scope !== 'delta' || !previous) {
    if (!previous) return next;
    // A `final` snapshot replaces the accumulated deltas, because its totals are
    // authoritative. But the two halves of the context readout arrive on
    // opposite sides of that swap: deltas know `contextTokens` (the size of the
    // prompt), and only `final` knows `contextWindow` (a property of the model).
    // Replacing wholesale means the readout never has both at once and renders
    // "no run yet" forever. The last delta's `contextTokens` is the real prompt
    // size, so it survives the swap.
    return {
      ...next,
      ...(next.contextTokens === undefined && previous.contextTokens !== undefined
        ? { contextTokens: previous.contextTokens }
        : {}),
    };
  }
  return {
    ...next,
    scope: 'cumulative',
    tokens: addTokens(previous.tokens, next.tokens),
    ...(previous.costUsd === undefined && next.costUsd === undefined
      ? {}
      : { costUsd: (previous.costUsd ?? 0) + (next.costUsd ?? 0) }),
    ...(next.contextTokens === undefined && previous.contextTokens !== undefined
      ? { contextTokens: previous.contextTokens }
      : {}),
    ...(next.contextWindow === undefined && previous.contextWindow !== undefined
      ? { contextWindow: previous.contextWindow }
      : {}),
  };
}

/**
 * Route one event to the column that owns its run.
 *
 * Events are multiplexed across every run the main process is driving — every
 * window's, and both of this window's columns'. The `runId` is the whole
 * routing key: a pane owns exactly the events for the run it started, and an
 * event for a run nobody here owns (another window's, or one whose column has
 * since been closed) is dropped rather than interleaved into whichever
 * transcript happens to be on screen.
 */
/**
 * Runs whose retained history is still being fetched.
 *
 * A run being re-attached after a reload has two sources of truth for a moment
 * — the buffer the main process kept, and the live feed — and they must be
 * applied in `seq` order or the transcript reads backwards. Events land here
 * while the fetch is in flight and {@link attachRun} drains them behind the
 * replay. Empty in every other circumstance, which is why the lookup is the
 * first thing on the streaming path and nothing else is.
 */
const replayBuffers = new Map<RunId, AgentEvent[]>();

export function handleAgentEvent(event: AgentEvent): void {
  const held = replayBuffers.get(event.runId);
  if (held !== undefined) {
    held.push(event);
    return;
  }
  applyAgentEvent(event);
}

/**
 * Give a turn nobody in this window started the conversation it belongs to.
 *
 * The provider takes turns of its own now: told that background work finished,
 * the agent answers, with no prompt from anyone. Those arrive on a run id this
 * window has never seen, and `applyAgentEvent` routes on run id alone — so
 * without this they are dropped, and the conversation on screen falls quietly
 * out of step with what the provider is writing to its own transcript, until
 * someone reopens it.
 *
 * `session.started` is the hook because it is the only event that names the
 * conversation, and it is always the first of a turn. From the pane's side this
 * is the same claim {@link adoptLiveRuns} makes at boot, one run at a time.
 *
 * ## Why the run state is built here rather than fetched
 *
 * A handle would have to come from `runs.list`, which is a round trip, and the
 * events would have to be held for it. That is a real hazard rather than a
 * hypothetical: an acknowledgement that a task finished can be over before the
 * answer comes back, and a run no longer live is no longer in that list. So the
 * pane synthesises the run from what it already has, which is sound because a
 * continuation is by construction inside the conversation this pane last ran:
 * the provider, the account, the directory and the capabilities were all fixed
 * when the process was spawned and cannot have changed under it.
 *
 * Two panes in different windows can both hold the session, and both should
 * show the turn — it is one conversation, open twice.
 *
 * Silent in three cases. A session no pane here holds is another window's
 * business. A pane already running something is not free to be repointed: only
 * the race where the user got a prompt in first can produce that, and stealing
 * the column would lose the run they can see. And a pane that has never run
 * anything nor picked an account cannot say whose turn this is, which is a
 * conversation it could not have continued anyway.
 */
function claimContinuation(event: AgentEvent): Pane | undefined {
  if (event.type !== 'session.started') return undefined;

  const pane = paneForSession(event.sessionId);
  if (!pane) return undefined;

  const state = paneState(pane);
  if (isLive(state)) return undefined;

  const profileId = state.run?.profileId ?? state.activeProfileId;
  if (!profileId) return undefined;

  setPaneState(pane, {
    run: {
      ...state.run,
      runId: event.runId,
      status: 'running',
      sessionId: event.sessionId,
      providerId: state.run?.providerId ?? state.activeProviderId,
      profileId,
      cwd: state.run?.cwd ?? state.cwd,
      capabilities: state.run?.capabilities ?? activeCapabilities(state),
      // The turn started when the provider started it, which was moments ago and
      // is not knowable more precisely from here. Carrying the previous run's
      // time instead would date this turn to the last thing the user typed.
      startedAt: Date.now(),
      // Belongs to the run that ended, and would otherwise describe this one as
      // having finished before its first event was applied.
      endReason: undefined,
      error: undefined,
    },
  });
  return pane;
}

function applyAgentEvent(event: AgentEvent): void {
  const pane = paneForRun(event.runId) ?? claimContinuation(event);
  if (!pane) return;
  const run = paneState(pane).run;
  if (!run) return;

  pane.transcript.apply(event);

  switch (event.type) {
    /*
     * An artifact arriving. Read from `tool.end` rather than `tool.start`
     * because a write that was denied, cancelled or failed left no file — or
     * left half of one — and opening a pane onto it would answer the user's
     * first sight of the artifact with a failure a moment later. The same
     * reasoning the Preview button on the row already follows.
     */
    case 'tool.end': {
      if (event.status !== 'ok') break;
      /*
       * The arguments come from the transcript item, not from the event: a
       * `tool.end` carries the result and not the input. `apply` above has
       * already merged this event onto the item `tool.start` created, so the
       * item is the one place both halves of the call exist.
       */
      const item = pane.transcript.getItem(`t:${event.toolCallId}`);
      if (item?.kind !== 'tool') break;
      const artifact = detectArtifact(
        detectFileEdit(item.name, item.input),
        paneState(pane).cwd,
        useApp.getState().platform,
      );
      if (artifact !== null) maybeAutoOpen(pane, artifact);
      break;
    }

    /*
     * The whole set, swapped in. Never merged — that is the event's contract,
     * and it is what makes a missed one impossible to wedge a spinner with.
     *
     * On the pane rather than in the transcript because a task is not a thing
     * that was *said*: the set is replaced as work comes and goes, so a row for
     * it would either be rewritten in place in a thread that never rewrites, or
     * become one entry per change, which is a log of a list. The dock pane is
     * the surface for it, and this is what feeds it.
     */
    case 'background.tasks': {
      /*
       * The dismissal record is pruned against the same set, so that it only
       * ever names rows the provider is still reporting. Left to grow it would
       * accumulate every task the session ever ran, and the `some` that reads it
       * runs on every one of these messages.
       *
       * Rewritten only when something was actually dropped — `filter` preserves
       * order and only removes, so an unchanged length is an unchanged array,
       * and a needless write here would rebuild the strip several times a second
       * for every column with an agent working in it.
       */
      const { dismissedTasks } = paneState(pane);
      const reported = new Set(event.tasks.map((task) => task.id));
      const kept = dismissedTasks.filter((id) => reported.has(id));
      setPaneState(pane, {
        tasks: event.tasks,
        ...(kept.length === dismissedTasks.length ? {} : { dismissedTasks: kept }),
      });
      break;
    }

    case 'session.started':
      setPaneState(pane, {
        run: {
          ...run,
          status: run.status === 'ended' ? 'ended' : 'running',
          sessionId: event.sessionId,
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.tools === undefined ? {} : { tools: event.tools }),
          ...(event.slashCommands === undefined ? {} : { slashCommands: event.slashCommands }),
          ...(event.permissionMode === undefined ? {} : { permissionMode: event.permissionMode }),
        },
      });
      // A session that has only just been created is not in the list the
      // sidebar is currently showing. Waiting for `run.end` to reveal it means
      // the thing the user is watching happen is the one thing missing from
      // their history.
      refreshSessionsSoon();
      break;

    case 'permission.request':
      setPaneState(pane, (s) => ({
        permissionQueue: [...s.permissionQueue, event.request],
        // `ended` survives, the same guard `session.started` above applies: a
        // request straggling in after `run.end` — a re-ordered transport, a
        // replay — must not flip a finished conversation back to live. Nothing
        // can answer on a run the registry has already retired, and a pane
        // resurrected this way would lock its composer on a wait that cannot
        // end.
        run:
          s.run && s.run.status !== 'ended'
            ? { ...s.run, status: 'awaiting_permission' }
            : s.run,
      }));
      break;

    /*
     * Take it back off the queue, wherever the answer came from.
     *
     * For the window that sent the decision this is redundant — `respondToPermission`
     * already dropped it — and idempotent, because `dropPermissionRequest`
     * filters by id. It earns its place on every other path: a second window,
     * a request the provider withdrew, and above all a reload, where the queue
     * is rebuilt from the replayed history and would otherwise come back
     * holding every prompt the run ever raised.
     */
    case 'permission.resolved':
      dropPermissionRequest(event.requestId, pane);
      break;

    case 'usage': {
      setPaneState(pane, (s) =>
        s.run ? { run: { ...s.run, usage: mergeUsage(s.run.usage, event.usage) } } : {},
      );
      // The learned window is the *window's*, not this column's — it is a fact
      // about a model, and the other column running the same one should not
      // have to learn it again. Written to the app store, from where the mirror
      // hands it to both panes.
      const model = paneState(pane).run?.model;
      const learned = event.usage.contextWindow;
      if (learned !== undefined && model !== undefined) {
        useApp.setState((s) =>
          s.contextWindows[model] === learned
            ? {}
            : { contextWindows: { ...s.contextWindows, [model]: learned } },
        );
      }
      break;
    }

    case 'run.end': {
      // A run is one turn cycle, so the next prompt starts a *new* run. Unless
      // that run is pointed back at this one's session it opens a fresh
      // provider session with no memory of what was just said — the transcript
      // on screen would show a conversation the provider never had. Carrying
      // the session id forward here is what makes turn two a continuation.
      //
      // Only when the run could be resumed at all, and only while the user is
      // still pointed at the same directory and profile: a session id is scoped
      // to the config dir and cwd it was created under, so promoting one across
      // a switch would resume the wrong history.
      const state = paneState(pane);
      const endedSessionId = event.sessionId ?? run.sessionId;
      const resumable =
        run.capabilities.resumeSession &&
        endedSessionId !== undefined &&
        state.cwd === run.cwd &&
        state.activeProfileId === run.profileId;

      setPaneState(pane, (s) => ({
        permissionQueue: [],
        // `tasks` is deliberately not cleared here. Work that outlived the turn
        // that launched it is exactly what this list is for, and a run ending is
        // the moment it becomes the only record of it.
        // `forkOnResume` is a one-shot choice. The fork already happened and
        // `endedSessionId` is the fork's own id, so leaving the flag set would
        // fork the fork on the next turn.
        ...(resumable ? { resumeSessionId: endedSessionId, forkOnResume: false } : {}),
        run: s.run
          ? {
              ...s.run,
              status: 'ended',
              endReason: event.reason,
              ...(event.error === undefined ? {} : { error: event.error }),
              ...(event.usage === undefined ? {} : { usage: event.usage }),
              ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
            }
          : s.run,
      }));
      if (event.error) {
        pushBanner('error', `Run failed: ${event.error.message}`, describeError(event.error));
      }
      // A backgrounded conversation that has finished is no longer holding
      // anything the provider's own file does not — except this end card. A few
      // are kept for the user who comes back to ask what happened; see
      // `MAX_BACKGROUND_ENDED`.
      pruneBackground();
      // Deliberately *not* immediate — see `SESSION_SETTLE_MS`. The provider is
      // still writing this session's file as the event arrives, so reading now
      // reliably returns the previous turn's title.
      refreshSessionsSoon();
      // And re-read what the turn cost the account. `run.profileId` rather than
      // the pane's current selection: a run bills the account it started on for
      // its whole life, and the pane may well have moved on by now.
      refreshPlanUsageSoon(run.profileId);
      // The handoff turn is the one that just ended, so the document is written
      // and this conversation is finished on this account. `done` is what makes
      // the next prompt ask the user to move rather than silently spend the
      // runway the handoff was bought with.
      if (paneState(pane).handoff === 'asked') setHandoff(pane, 'done');
      break;
    }

    default:
      break;
  }
}
