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
  isSameModel,
  NO_CAPABILITIES,
  recommendProfile,
  resolvePlanWeight,
} from '@rx-artemis/protocol';
import type {
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
  PlanMeterFocus,
  PlanRecommendation,
  PlanUsage,
  PreviewOpenResponse,
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
  SessionId,
  SessionSummary,
  TokenUsage,
  UsageSnapshot,
} from '@rx-artemis/protocol';
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
import { isAbsolutePath } from '../lib/paths';
import { newId } from '../lib/id';
import { sessionKey } from '../lib/sessionGroups';
import type { PermissionItem, TranscriptModel } from './transcript';
import {
  MIRRORED_KEYS,
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
export type SettingsSection = 'profiles' | 'models' | 'appearance' | 'permissions';

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

export type { PlanMeterFocus };

/**
 * Which conversation a preview belongs to.
 *
 * A preview is not a window-level object even though it is drawn at window
 * level: it is a file *this* conversation wrote, and it makes no sense beside a
 * different one. Recorded at open time and checked by {@link reconcilePreview},
 * which closes the pane once the conversation it came from is no longer in a
 * column.
 *
 * Both a session id and a run id, because neither alone covers the life of a
 * conversation. A run has no `sessionId` until `session.started` arrives — which
 * is precisely the window in which the first artifact of a fresh conversation is
 * usually written — so the run id is what identifies it until the session id
 * exists, at which point {@link reconcilePreview} adopts the id and the
 * ownership survives the run ending.
 */
export interface PreviewOwner {
  readonly paneId: PaneId;
  readonly runId?: RunId;
  readonly sessionId?: SessionId;
}

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
   * Sort keys held still for the sessions being written right now.
   *
   * The sidebar orders by `updatedAt`, which is the transcript file's mtime, and
   * a working agent rewrites that file every few seconds. With one session
   * running nobody notices — it is already at the top. With several, every poll
   * re-answered "who wrote most recently" with a different name, so rows swapped
   * places and whole project groups jumped the queue while the user was reading
   * them, roughly every four seconds. Rows are positioned by index, so they
   * teleport; a list that reshuffles under the pointer is also a list that opens
   * the wrong session.
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
   * The list is therefore ordered by "most recently started or written", and it
   * only ever moves on something the user did.
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
   * A shortlist is a statement about which models the *user* likes, not about
   * an account, so it stays here and is mirrored into every pane rather than
   * kept per column.
   */
  readonly quickModelIds: readonly string[];
  /** How wide the transcript column may grow. */
  readonly conversationWidth: ConversationWidth;
  /** How much of the run-end accounting the transcript keeps. */
  readonly runSummary: RunSummary;
  /** Which plan-limit window the status-bar meter reports. */
  readonly planMeterFocus: PlanMeterFocus;
  /** Base text size in px — what `text-base` renders at. @see clampFontSize */
  readonly fontSize: number;
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
];

const CONVERSATION_WIDTHS: readonly ConversationWidth[] = ['comfortable', 'wide', 'full'];

/** Show the whole block. What the app did before this was settable. */
export const DEFAULT_RUN_SUMMARY: RunSummary = 'always';

const RUN_SUMMARIES: readonly RunSummary[] = ['always', 'failures', 'never'];

/**
 * The 5-hour window, because it is the one that actually interrupts work.
 *
 * A weekly limit is a budgeting fact you act on over days; the 5-hour window is
 * the one that stops you mid-task, so it is what a permanently-visible meter
 * should be counting down.
 */
export const DEFAULT_PLAN_METER_FOCUS: PlanMeterFocus = 'five_hour';

const PLAN_METER_FOCUSES: readonly PlanMeterFocus[] = ['five_hour', 'seven_day', 'model'];

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
  settingsSection?: SettingsSection;
  quickModelIds?: readonly string[];
  fastMode?: boolean;
  ultracode?: boolean;
  conversationWidth?: ConversationWidth;
  runSummary?: RunSummary;
  planMeterFocus?: PlanMeterFocus;
  fontSize?: number;
  streamingWordFade?: boolean;
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

function loadPrefs(): Prefs {
  let raw: Record<string, unknown>;
  try {
    const text = globalThis.localStorage?.getItem(PREFS_KEY);
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
    quickModelIds: stringList(raw['quickModelIds']),
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
    planMeterFocus: oneOf(raw['planMeterFocus'], PLAN_METER_FOCUSES),
    streamingWordFade: boolOrUndefined(raw['streamingWordFade']),
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
    // Same treatment again, and here the entry is rendered rather than matched:
    // a non-string surviving into the menu would reach `lastSegment` and throw
    // on a control the user opens to get *out* of a bad directory.
    recentFolders: stringList(raw['recentFolders']),
  };
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
    settingsSection: s.settingsSection,
    quickModelIds: s.quickModelIds,
    conversationWidth: s.conversationWidth,
    runSummary: s.runSummary,
    planMeterFocus: s.planMeterFocus,
    fontSize: s.fontSize,
    streamingWordFade: s.streamingWordFade,
    contextWindows: s.contextWindows,
  };
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
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
    quickModelIds: prefs.quickModelIds ?? [],

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
    models: [],
    modelsLoading: false,
    modelsError: null,
    run: null,
    permissionQueue: [],
    promptHistory: [],
    draft: '',
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
 * Two projections rather than one subscription each, because they are triggered
 * by exactly the same events — a run starting, ending, or a session being
 * resumed into a column — and splitting them would only mean walking the panes
 * twice. Both are written to be cheap and to write nothing when nothing moved;
 * this runs on every keystroke in a composer, which shares the pane's store.
 */
function syncFromPanes(): void {
  syncRunningSessions();
  reconcilePreview();
}

/** Mint a conversation the window is already watching. The only way panes are made. */
function openPane(initial: SessionState): Pane {
  const pane = createPane(initial);
  paneWatchers.set(pane.id, pane.store.subscribe(syncFromPanes));
  return pane;
}

const firstPane = openPane(seedSession());

export const useApp = create<AppState>(() => ({
  bridgeMode: 'unavailable',
  version: '',
  platform: 'darwin',
  booted: false,

  grid: [createRow([firstPane])],
  background: [],
  runningSessions: [],
  sessionOrderHold: {},
  focusedPaneId: firstPane.id,
  paneLayout: prefs.paneLayout ?? {},
  preview: null,

  providers: [],
  profiles: [],
  authByProfile: {},
  planUsageByProfile: {},

  quickModelIds: prefs.quickModelIds ?? [],
  conversationWidth: prefs.conversationWidth ?? DEFAULT_CONVERSATION_WIDTH,
  runSummary: prefs.runSummary ?? DEFAULT_RUN_SUMMARY,
  planMeterFocus: prefs.planMeterFocus ?? DEFAULT_PLAN_METER_FOCUS,
  fontSize: initialFontSize,
  // `??`, not `||`: a persisted `false` is the whole point of the setting and
  // must survive a reload.
  streamingWordFade: prefs.streamingWordFade ?? true,

  sessions: [],
  sessionsScope: 'all',
  sessionsLoading: false,
  sessionsError: null,

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
  for (const pane of allLivePanes()) {
    const state = paneState(pane);
    if (!isLive(state)) continue;
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

  const current = useApp.getState().runningSessions;
  if (current.length === ids.length && ids.every((id, i) => current[i] === id)) return;
  useApp.setState({ runningSessions: ids, sessionOrderHold: holdOrder(ids) });
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
    quickModelIds: state.quickModelIds,
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
  const state = paneState(pane);
  const sessionId = sessionShownBy(state);
  useApp.setState({
    preview: {
      ...res.value,
      owner: {
        paneId: pane.id,
        ...(state.run === null ? {} : { runId: state.run.runId }),
        ...(sessionId === null ? {} : { sessionId }),
      },
    },
  });
}

/** Close the preview pane. Nothing to tell the main process — see `preview.ts`. */
export function closePreview(): void {
  if (useApp.getState().preview === null) return;
  useApp.setState({ preview: null });
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
 * Close the preview once the conversation that produced it has left the screen.
 *
 * An artifact is a thing *a conversation* made. Leaving it framed beside a
 * different conversation — or beside none, after its column was closed — is the
 * app asserting a relationship that no longer exists: the pane still says
 * `report.html`, and nothing on screen connects it to work the user can still
 * see. So it is not a persistent window object; it lives exactly as long as its
 * conversation has a column.
 *
 * **Visible panes only, and not `allLivePanes`.** A backgrounded run is one the
 * user navigated away from; keeping its artifact on screen while its transcript
 * is not is the same orphaning by another route. Backgrounding a conversation
 * closes its preview, and coming back to that conversation does not reopen it —
 * the tile in the transcript is the way back in, which is the whole reason the
 * tile exists.
 *
 * Runs on every pane write and every window write, which is often; it is written
 * to do nothing at all in the overwhelmingly common case where there is no
 * preview open.
 */
function reconcilePreview(): void {
  const preview = useApp.getState().preview;
  if (preview === null) return;

  const { owner } = preview;
  const panes = allPanes();

  /*
   * Adopt a session id the owning run has learned since. A conversation
   * previewed before `session.started` is owned by its run; once it has a
   * session id, that is the durable identity — it is what survives the run
   * ending, and what a later resume of the same conversation will match on.
   */
  if (owner.sessionId === undefined && owner.runId !== undefined) {
    const home = panes.find((pane) => pane.id === owner.paneId);
    const learned = home === undefined ? null : sessionShownBy(paneState(home));
    if (home !== undefined && learned !== null && paneState(home).run?.runId === owner.runId) {
      useApp.setState({ preview: { ...preview, owner: { ...owner, sessionId: learned } } });
      return;
    }
  }

  const stillShown = panes.some((pane) => {
    const state = paneState(pane);
    if (owner.sessionId !== undefined) return sessionShownBy(state) === owner.sessionId;
    // No session id yet: identity is the run, in the column it started in. A
    // pane whose run has been replaced is showing a different conversation even
    // though the column is the same one.
    return pane.id === owner.paneId && state.run?.runId === owner.runId;
  });

  if (!stillShown) useApp.setState({ preview: null });
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
    quickModelIds: state.quickModelIds,
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
  // Any catalogue fetch still in flight for it has nowhere to land. Dropping the
  // token both releases the entry and makes the reply's own staleness check
  // fail, which is what stops it writing into a store nothing is subscribed to.
  modelsRequestToken.delete(pane.id);
}

/** Evict finished conversations past {@link MAX_BACKGROUND_ENDED}, oldest first. */
function pruneBackground(): void {
  const { background } = useApp.getState();
  const ended = background.filter((pane) => !isLive(paneState(pane)));
  if (ended.length <= MAX_BACKGROUND_ENDED) return;

  const evicted = new Set(ended.slice(0, ended.length - MAX_BACKGROUND_ENDED).map((p) => p.id));
  for (const pane of background) if (evicted.has(pane.id)) retirePane(pane);
  useApp.setState({ background: background.filter((pane) => !evicted.has(pane.id)) });
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

  const keep = isLive(paneState(outgoing));
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

  if (!keep) retirePane(outgoing);
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

  const keep = isLive(paneState(pane));
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

export function activeProfile(state: SessionState): ProfileMetadata | undefined {
  return state.profiles.find((p) => p.id === state.activeProfileId);
}

/**
 * Which account has the most plan capacity left, from the polled readings.
 *
 * **Not a `useApp` selector**, deliberately — `recommendProfile` returns a
 * fresh object every call, and a selector whose result is never identical to
 * its predecessor re-renders on every store read until React gives up (see
 * `NO_OPTIONS` above for the same trap). Components subscribe to the two
 * *stable* inputs and call this inside a `useMemo`.
 *
 * `now` is a parameter rather than read here so the caller decides when
 * staleness is re-judged — the profile menu computes it as the menu opens,
 * which is exactly when the answer is about to be acted on.
 *
 * Profiles are passed in list order, which is what breaks ties: see
 * `recommendProfile`.
 */
export function planRecommendation(
  profiles: readonly ProfileMetadata[],
  usageByProfile: Readonly<Record<ProfileId, PlanUsage>>,
  now: number,
): PlanRecommendation | null {
  return recommendProfile(
    profiles.map((profile) => {
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

export function quickModels(state: SessionState): readonly ProviderModelOption[] {
  return computeQuickModels(activeModels(state), state.quickModelIds);
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
  });
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

  await Promise.all([refreshProviders(), refreshProfiles()]);
  await adoptLiveRuns(focusedPane());
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
  // Cache reads, so this contacts no provider — see `seedPlanUsage`. It is what
  // makes the profile menu's recommendation available immediately in a window
  // opened into an app that has been running for hours.
  void seedPlanUsage(useApp.getState().profiles);
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
   */
  useApp.setState({ profiles });
  for (const pane of allPanes()) {
    setPaneState(pane, (s) => {
      const current = s.activeProfileId;
      if (current !== null && profiles.some((p) => p.id === current)) return {};

      const adopted =
        profiles.find((p) => p.providerId === s.activeProviderId) ?? profiles[0] ?? null;
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
      // The shortlist is the window's, so its migration is written to the window
      // store — from where the mirror puts the carried ids in front of *both*
      // columns' pickers, which is right: the pins did not move, the catalogue
      // renaming them did.
      const quickModelIds = carryModelIds(useApp.getState().quickModelIds, outgoing, models);
      const model = before.model === null ? null : carryModelId(before.model, outgoing, models);

      setPaneState(pane, { models, modelsError: null, model });
      if (quickModelIds !== useApp.getState().quickModelIds) useApp.setState({ quickModelIds });
      // Only when something actually moved. Persisting the carried ids is what
      // stops the migration from running again on every launch, and skipping the
      // write in the common case keeps a background refresh silent.
      if (quickModelIds !== before.quickModelIds || model !== before.model) savePrefs();
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

  await attachRun(pane, first);

  const adopted: Pane[] = [];
  for (const handle of rest) {
    const extra = openPane(seedSession());
    adopted.push(extra);
    await attachRun(extra, handle);
  }
  if (adopted.length > 0) {
    useApp.setState((s) => ({ background: [...s.background, ...adopted] }));
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

  replayBuffers.set(handle.runId, []);
  pane.transcript.reset();
  setPaneState(pane, {
    run: fromHandle(handle),
    activeProviderId: handle.providerId,
    activeProfileId: handle.profileId,
    cwd: handle.cwd,
    permissionQueue: [],
    // The session the next prompt continues is this run's own. Set now rather
    // than waiting for `run.end`, because until it is set the sidebar cannot
    // mark the row the user needs in order to find this conversation again.
    ...(handle.sessionId === undefined ? {} : { resumeSessionId: handle.sessionId }),
  });

  let lastSeq = -1;
  try {
    await replayEarlierTurns(pane, handle);
    const replay = await call(() => bridge.runs.events({ runId: handle.runId }));
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
async function replayEarlierTurns(pane: Pane, handle: RunHandle): Promise<void> {
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

export function setProvider(providerId: ProviderId, pane: Pane = focusedPane()): void {
  setPaneState(pane, (s) => ({
    activeProviderId: providerId,
    activeProfileId:
      s.profiles.find((p) => p.id === s.activeProfileId)?.providerId === providerId
        ? s.activeProfileId
        : (s.profiles.find((p) => p.providerId === providerId)?.id ?? null),
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
}

/**
 * Point the app at an account.
 *
 * ## The provider moves with it
 *
 * A profile belongs to exactly one CLI, so selecting one selects that CLI too.
 * This is the same rule `createProfile` states at length, and it is stated in
 * both places because both are routes to "which account runs" — leaving a Codex
 * profile active while `activeProviderId` still said `claude` would ask the
 * Claude adapter to answer for an account it has never heard of.
 *
 * Reading the provider off the profile rather than requiring the caller to move
 * the two together is what makes the picker able to span providers. It used to
 * be scoped to the active provider *because* selecting across one would have
 * desynced them, and that scoping was the bug: creating a Codex profile moved
 * the app to Codex, at which point every Claude account vanished from the only
 * picker on screen and the provider list in the palette was the sole way back.
 *
 * An unknown id is ignored rather than applied. It can only come from a stale
 * render of a profile that has since been deleted, and honouring it would point
 * the app at an account that is not there.
 */
export function setProfile(profileId: ProfileId, pane: Pane = focusedPane()): void {
  const state = paneState(pane);
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) return;

  const switched = state.activeProviderId !== profile.providerId;
  setPaneState(pane, {
    activeProfileId: profileId,
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
  if (paneState(pane).cwd !== cwd) return;
  setPaneState(pane, { workspace: names });
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
 * Record that a directory was worked in.
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
 */
function rememberFolder(path: string): void {
  useApp.setState((s) => {
    const recentFolders = promoteFolder(s.recentFolders, path);
    // `promoteFolder` hands back the same array when nothing moved, and this
    // runs on every directory adoption — returning a fresh object each time
    // would re-render every menu subscriber for a no-op.
    return recentFolders === s.recentFolders ? {} : { recentFolders };
  });
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

export function setPermissionMode(mode: PermissionMode, pane: Pane = focusedPane()): void {
  setPaneState(pane, { permissionMode: mode });
  savePrefs();
}

/** Choose the model for the next run. `null` means the provider's default. */
export function setModel(model: string | null, pane: Pane = focusedPane()): void {
  setPaneState(pane, { model });
  savePrefs();
}

/** Choose the reasoning effort for the next run. `null` means the default. */
export function setEffort(effort: string | null, pane: Pane = focusedPane()): void {
  setPaneState(pane, { effort });
  savePrefs();
}

export function setForkOnResume(fork: boolean, pane: Pane = focusedPane()): void {
  setPaneState(pane, { forkOnResume: fork });
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
export function toggleQuickModel(id: string): void {
  useApp.setState((s) => ({
    quickModelIds: s.quickModelIds.includes(id)
      ? s.quickModelIds.filter((existing) => existing !== id)
      : [...s.quickModelIds, id],
  }));
  savePrefs();
}

/** Replace the whole pinned set — for a settings pane that edits it as a list. */
export function setQuickModels(ids: readonly string[]): void {
  useApp.setState({ quickModelIds: [...ids] });
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
  savePrefs();
}

/** The same, for ultracode. @see setFastMode for why the two are exclusive. */
export function setUltracode(on: boolean, pane: Pane = focusedPane()): void {
  setPaneState(pane, on ? { ultracode: true, fastMode: false } : { ultracode: false });
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

export function setPlanMeterFocus(focus: PlanMeterFocus): void {
  useApp.setState({ planMeterFocus: focus });
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
 *
 * Purely local — see {@link AppState.archivedSessions}. No IPC, nothing on
 * disk changes, and the session stays resumable the whole time; the row simply
 * moves from its project into the Archived section.
 */
export function toggleSessionArchived(session: SessionSummary): void {
  const key = sessionKey(session);
  useApp.setState((s) => ({
    archivedSessions: s.archivedSessions.includes(key)
      ? s.archivedSessions.filter((entry) => entry !== key)
      : [...s.archivedSessions, key],
  }));
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
  useApp.setState((s) => ({
    sessions: s.sessions.filter((entry) => sessionKey(entry) !== key),
    // Swept together with the row. An archive key for a session that no longer
    // exists is inert, but it would accumulate in the persisted preferences
    // forever, and a session id that came round again would arrive pre-hidden.
    archivedSessions: s.archivedSessions.filter((entry) => entry !== key),
  }));
  // A deleted session cannot be resumed, and leaving it selected would aim the
  // next prompt at a transcript that is gone.
  //
  // Every pane, not just the focused one: the same session can be open in more
  // than one column — the sidebar row marks it active while it is showing
  // anywhere — and clearing only the pane the user happened to right-click from
  // would leave the others pointed at a file that no longer exists.
  for (const pane of allPanes()) {
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
    schedule();
  };

  const onWake = (): void => {
    if (stopped) return;
    void refreshSessions();
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
  // A working conversation moves aside intact; an idle one is simply cleared,
  // which avoids remounting the column — and the composer the user is typing in
  // — for what is, in that case, nothing more than an erase.
  let target = pane;
  if (isLive(paneState(pane))) {
    target = handOffToBlank(pane);
  } else {
    pane.transcript.reset();
    setPaneState(pane, { run: null, resumeSessionId: null, permissionQueue: [] });
  }

  if (adoptRecommendedProfile) {
    // Read off the app store, where the poll writes: the readings are
    // window-wide facts about accounts, not column state.
    const { profiles, planUsageByProfile } = useApp.getState();
    const recommended = planRecommendation(profiles, planUsageByProfile, Date.now());
    if (recommended !== null && recommended.profileId !== paneState(target).activeProfileId) {
      setProfile(recommended.profileId, target);
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

  const profile = state.profiles.find((p) => p.id === session.profileId);
  if (!profile) {
    pushBanner(
      'error',
      'That session’s profile no longer exists',
      'A session lives inside the profile that created it, so it cannot be resumed from another one.',
    );
    return;
  }

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

  const switchedProfile = state.activeProfileId !== session.profileId;
  const switchedCwd = state.cwd !== session.cwd;

  // Whatever this column was working on moves aside rather than being killed —
  // the same rule as `newSession`, for the same reason. `target` is the pane
  // that now holds the column and everything below is done to it.
  const target = isLive(state) ? handOffToBlank(pane) : pane;
  target.transcript.reset();
  setPaneState(target, {
    run: null,
    activeProviderId: session.providerId,
    activeProfileId: session.profileId,
    cwd: session.cwd,
    resumeSessionId: session.id,
    forkOnResume: false,
    permissionQueue: [],
    // Same rule as `setProvider`: a catalogue belongs to a provider, so
    // landing on a different one has to drop it rather than show the previous
    // provider's models under the new one's name.
    ...(state.activeProviderId === session.providerId ? {} : { models: [], modelsError: null }),
  });
  // Opening a session is a deliberate act on one column, so that column takes
  // the focus — which is what makes ⌘K, the run inspector and settings point
  // at what the user just opened rather than at whatever they last clicked.
  useApp.setState({ paletteOpen: false, focusedPaneId: target.id });
  // Recorded here for the same reason `refreshWorkspace` is: this function
  // writes `cwd` without going through `setCwd`, so everything hanging off a
  // directory change has to be done by hand. Continuing yesterday's session in
  // another project is exactly the trip the folder menu exists to save.
  rememberFolder(session.cwd);
  savePrefs();

  const moved = [
    switchedProfile ? `profile → ${profile.label}` : '',
    switchedCwd ? `directory → ${session.cwd}` : '',
  ].filter(Boolean);

  if (moved.length > 0) {
    target.transcript.note(
      'info',
      `Continuing "${session.title}"`,
      `Switched ${moved.join(' and ')}, because a session only resumes under the profile and directory it was created in.`,
    );
  }

  void loadSessionHistory(session, target);
  invalidateSessions();
  void refreshSessions();
  void refreshModels(target);
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

  // Recorded before the send is attempted. Up-arrow recall is about getting a
  // prompt back, and the prompt you most want back is the one that just failed
  // to go anywhere.
  rememberPrompt(prompt, pane);

  const live = isLive(state) ? state.run : null;

  // Filtered against the capabilities of the run that will actually carry them
  // — the *live* run mid-steer, the active provider otherwise. Those differ
  // after a provider switch mid-run, and the wrong one would either drop a
  // supported attachment or send one into a run that will refuse it.
  //
  // Per kind, because a provider can plausibly take one and not the other, and
  // dropping the whole set because half of it is unsupported would lose files
  // the run could have carried.
  const carrier = live ? live.capabilities : activeCapabilities(state);
  const kept = (attachments ?? []).filter((attachment) =>
    attachment.kind === 'image' ? carrier.imageInput : carrier.fileInput,
  );
  const sending = kept.length > 0 ? kept : undefined;

  if (live) {
    if (!live.capabilities.midRunSteering) {
      pushBanner('warn', 'This provider cannot take input mid-run');
      return false;
    }
    const steerId = pane.transcript.pushUserMessage(prompt, sending);
    const result = await call(() =>
      bridge.runs.send({
        runId: live.runId,
        text: prompt,
        ...(sending === undefined ? {} : { attachments: sending }),
      }),
    );
    if (!result.ok) {
      reportFailure('Could not deliver the message', result.error);
      // True: the message is in the transcript, dimmed, with its attachments. See
      // the note on this function for why that counts as sent from here.
      return true;
    }
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

  const runId = newId('run');
  const capabilities = activeCapabilities(state);
  const promptId = pane.transcript.pushUserMessage(prompt, sending);
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
        }
      : {}),
  };

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
export async function createProfile(draft: ProfileDraft): Promise<boolean> {
  const { bridge } = resolveBridge();
  if (!bridge) return false;
  const result = await call(() => bridge.profiles.create({ draft }));
  if (!result.ok) {
    reportFailure('Could not create the profile', result.error);
    return false;
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
  return true;
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

function applyAgentEvent(event: AgentEvent): void {
  const pane = paneForRun(event.runId);
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
        run: s.run ? { ...s.run, status: 'awaiting_permission' } : s.run,
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
      break;
    }

    default:
      break;
  }
}
