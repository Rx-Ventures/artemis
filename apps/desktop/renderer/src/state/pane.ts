/**
 * A pane: one working column, and everything scoped to the session inside it.
 * ============================================================================
 *
 * The app used to show exactly one conversation, and said so in its state: a
 * single `cwd`, a single `run`, a single permission queue, a single transcript
 * instance. Split view is the change that makes that untrue, and this file is
 * where the untruth is repaired — not by adding a second copy of the app, but
 * by naming the slice of state that was never really about the *window*.
 *
 * ## What is a pane's, and what is the window's
 *
 * A pane owns everything that answers **"what will the next prompt in this
 * column do, and what has it done so far"**: the directory, the profile and
 * provider it bills, the model and thinking level, the live run, the parked
 * permission prompts, the prompt history, and the transcript itself.
 *
 * The window owns everything that is about the *application*: the session list,
 * the profile and provider catalogues, the sidebar's geometry, the banners, the
 * palette, the settings surface. Those live in `store.ts` and there is one of
 * each no matter how many panes are open.
 *
 * The split is not cosmetic. `resumeSession` moves the profile, the provider and
 * the directory together, because a session id only resolves under the config
 * directory and cwd it was written in — so opening a second session side by side
 * has to move *that pane's* three, and must not touch the other column's. Every
 * field below is here because a split view would otherwise let one conversation
 * silently retarget the other.
 *
 * ## The mirrored fields, and why they are duplicated on purpose
 *
 * Five window-owned values are copied into every pane: `providers`, `profiles`,
 * `sessions`, `contextWindows` and `quickModelIds`. They are not pane state and
 * nothing here may write them — `store.ts` mirrors them on every change, from
 * one place, and that is the only writer.
 *
 * They are duplicated because the store's selectors are *joins* over both
 * halves. `activeCapabilities` needs this pane's `run` and the window's
 * `providers`; `lastKnownBranch` needs this pane's `cwd` and the window's
 * `sessions`. A selector read through a zustand hook must be a pure function of
 * the state it subscribes to, or it will not re-render when its other half
 * changes — a status line that never notices a profile was renamed, and no way
 * to see why. Reaching into the global store from inside a selector is exactly
 * that bug. Mirroring keeps every selector honest and single-argument.
 *
 * The cost is a shallow copy of five references whenever the window changes
 * them, which happens on bootstrap, on a profile edit, and on a session-list
 * refresh — never on the streaming path.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AgentError,
  BackgroundTask,
  Capabilities,
  PermissionMode,
  PermissionRequest,
  ProfileId,
  ProfileMetadata,
  ProviderDescriptor,
  ProviderId,
  ProviderModelOption,
  RunEndReason,
  RunId,
  RunStatus,
  SessionId,
  SessionSummary,
  UsageSnapshot,
} from '@rx-artemis/protocol';
import type { WorkspaceNames } from '../lib/extensions';
import { detectArtifact } from '../lib/artifact';
import { detectFileEdit } from '../lib/diff';
import type { Platform } from '../lib/paths';
import { TranscriptModel } from './transcript';

/** Identifies a pane for the lifetime of the window. Not persisted. */
export type PaneId = string;

/** Renderer-side view of the live run. Mirrors `RunHandle` plus stream facts. */
export interface RunState {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly providerId: ProviderId;
  readonly profileId: ProfileId;
  readonly cwd: string;
  readonly capabilities: Capabilities;
  readonly startedAt: number;
  readonly sessionId?: SessionId;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly slashCommands?: readonly string[];
  readonly permissionMode?: PermissionMode;
  readonly usage?: UsageSnapshot;
  readonly endReason?: RunEndReason;
  readonly error?: AgentError;
}

/**
 * The window-owned values copied into every pane. See the file header.
 *
 * Listed as a type *and* as {@link MIRRORED_KEYS} so the two cannot drift: the
 * key list is what `store.ts` iterates, and the compiler checks it covers this
 * interface exactly.
 */
export interface MirroredState {
  readonly providers: readonly ProviderDescriptor[];
  readonly profiles: readonly ProfileMetadata[];
  readonly sessions: readonly SessionSummary[];
  readonly contextWindows: Readonly<Record<string, number>>;
  /**
   * Each profile's pinned shortlist, keyed by profile id.
   *
   * The *map* is mirrored rather than one profile's array, because which entry
   * applies is a per-pane question — {@link SessionState.activeProfileId} — and
   * a selector must be a pure function of the state it subscribes to. Mirroring
   * the resolved array instead would put the window in charge of a choice only
   * the pane can make, and two columns on two accounts would show one column's
   * shortlist in both pickers.
   *
   * Per profile rather than per window because catalogues are not comparable:
   * OpenCode reaches hundreds of models across twenty providers while Claude
   * ships a handful, so one shared shortlist is either swamped by one account's
   * lineup or empty for it. See `quickModels`.
   */
  readonly quickModelIdsByProfile: Readonly<Record<ProfileId, readonly string[]>>;
}

/** Every mirrored key, exactly once. The compiler enforces "exactly". */
export const MIRRORED_KEYS: readonly (keyof MirroredState)[] = [
  'providers',
  'profiles',
  'sessions',
  'contextWindows',
  'quickModelIdsByProfile',
];

/** One column's worth of state. Read through `usePane`, written by `store.ts`. */
export interface SessionState extends MirroredState {
  /**
   * The account the next run bills, and the CLI it speaks to.
   *
   * Per pane rather than per window because `resumeSession` moves both to match
   * the session it is opening. With one column that read as a window setting;
   * with two it plainly is not, and a resume in the right column that switched
   * the left column's account would bill work to somewhere the user never
   * looked.
   */
  readonly activeProviderId: ProviderId;
  readonly activeProfileId: ProfileId | null;

  /**
   * Where the agent works.
   *
   * It moves in exactly two places, and both keep it married to the transcript
   * in this column: `resumeSession` adopts the selected session's directory,
   * and `setCwd` ends the session rather than moving one somewhere its
   * transcript was never written.
   */
  readonly cwd: string;
  /** What {@link cwd} is called — repository name where there is one. */
  readonly workspace: WorkspaceNames | null;

  readonly permissionMode: PermissionMode;
  /** Model id for the next run, or `null` for the provider's default. */
  readonly model: string | null;
  /** Reasoning-effort id for the next run, or `null` for the provider default. */
  readonly effort: string | null;
  /** Ask the next run to trade reasoning depth for latency, where supported. */
  readonly fastMode: boolean;
  /** Ask the next run to spend materially more compute, where supported. */
  readonly ultracode: boolean;

  readonly forkOnResume: boolean;
  readonly resumeSessionId: SessionId | null;

  /**
   * The model catalogue this pane's *account* actually offers, or `[]`.
   *
   * Per pane because it is a property of the profile, and two panes can be
   * signed in as two different accounts. Never persisted.
   */
  readonly models: readonly ProviderModelOption[];
  readonly modelsLoading: boolean;
  readonly modelsError: string | null;

  readonly run: RunState | null;
  /**
   * Permission requests still awaiting an answer, for this column's run.
   *
   * Drives that run's `awaiting_permission` status and its status-line counter,
   * and is what tells Escape which request to deny — which is why it cannot be
   * shared: Escape in the focused column must not answer a prompt parked in the
   * other one.
   */
  readonly permissionQueue: readonly PermissionRequest[];
  /**
   * What this conversation has delegated: subagents, workflows, backgrounded
   * commands — running and recently settled.
   *
   * Per pane because a task belongs to a conversation, exactly as its transcript
   * does, and because two columns can each be running their own. Replaced
   * wholesale on every `background.tasks` event rather than merged, which is that
   * event's contract and the reason a missed message cannot leave a spinner
   * turning for work that finished.
   *
   * Survives a run ending, which is the point: the tasks worth showing are the
   * ones that outlived the turn that launched them. Never persisted — it
   * describes work inside a provider process, and a row restored from disk would
   * be a claim about a process that no longer exists.
   */
  readonly tasks: readonly BackgroundTask[];
  /**
   * The ids of the tasks that were on screen when the user shut the dock's
   * delegated tab, so that shutting it stays shut.
   *
   * Ids rather than a flag, because `tasks` is replaced wholesale several times
   * a second while anything is running: a boolean would be cleared by the next
   * progress message and the tab would reappear a moment after it was closed.
   * Against a set of ids, "is there work here the user has not already
   * dismissed" stays answerable through any number of those writes, and the
   * answer changes exactly once — when something genuinely new is delegated.
   *
   * Pruned to what is still in `tasks` on every one of those events, which
   * bounds it to the rows the provider is currently reporting rather than to
   * everything the session ever ran.
   */
  readonly dismissedTasks: readonly string[];
  /**
   * Whether the delegated tab on screen is one the user opened by hand.
   *
   * The mirror of {@link dismissedTasks}, and it exists for the setting that
   * record cannot answer for. With "the dock never opens on its own" turned off
   * the tab may not arrive by itself — but the header's Delegated button is a
   * press, not an arrival, and without somewhere to record that press the strip
   * has no way to tell the two apart. See `ShownConversation.tasksRequested`.
   *
   * A flag rather than ids, which is the opposite of the choice next door and
   * for the same reason: `dismissedTasks` has to survive `tasks` being replaced
   * several times a second, whereas this is a statement about the tab and not
   * about any row in it. New work arriving under an open tab belongs in it.
   *
   * Cleared by that tab's ✕ and at every conversation boundary, so it never
   * authorises the *next* column's uninvited tab.
   */
  readonly tasksRequested: boolean;
  /** Prompts sent in this column, newest last. Renderer-local, never persisted. */
  readonly promptHistory: readonly string[];
  /**
   * What is typed into this column's composer and not yet sent.
   *
   * Here rather than in the composer's own `useState`, and the reason is
   * structural rather than stylistic: opening or closing the second column
   * re-parents the surviving column in the React tree, which unmounts it — so
   * component-local text would be thrown away by an action about *the other*
   * conversation. Losing a half-written prompt because you closed a pane next
   * to it is not a trade anyone would accept.
   *
   * It is also simply the right home. "What have I typed but not sent" is a
   * fact about this conversation in exactly the way `promptHistory` beside it
   * is, and neither outlives the window.
   */
  readonly draft: string;
}

/**
 * A pane and its two stores.
 *
 * The transcript is a sibling of the state store, not a field in it, for the
 * reason `transcript.ts` gives at length: streaming text must never pass
 * through React state. One `TranscriptModel` per pane means a `text.delta` in
 * the right column notifies exactly the rows in the right column, and the left
 * column's transcript is not merely unaffected — it is not subscribed at all.
 */
export interface Pane {
  readonly id: PaneId;
  readonly store: StoreApi<SessionState>;
  readonly transcript: TranscriptModel;
}

/**
 * One row of the grid: panes side by side, left to right.
 *
 * The grid is **rows of columns**, not a matrix, and that asymmetry is the
 * whole design. A row's columns are its own, so a window can hold two
 * conversations over one — the third spanning the full width beneath the pair —
 * without the layout having to invent an empty cell to keep a rectangle
 * rectangular. Splitting right adds a column *to a row*; splitting down adds a
 * *row*, always full width.
 *
 * The regular shapes fall out of that rather than being special-cased: n across
 * is one row of n, n down is n rows of one, and a square is two rows of two.
 *
 * The id is the row's own and is stable for as long as the row exists, because
 * the panel library keys its layout by it.
 */
export interface PaneRow {
  readonly id: string;
  readonly panes: readonly Pane[];
}

let nextPaneId = 0;
let nextRowId = 0;

/**
 * The host platform, for the path arithmetic in {@link detectArtifact} — and,
 * through {@link hostPlatform}, for anyone else resolving a path outside a
 * component's render.
 *
 * Held here rather than read from the app store because that store imports
 * *this* module, and a pane reaching back into it for one scalar would close the
 * cycle. `bootstrap` pushes the real value in as soon as the bridge reports it;
 * until then this is the same `darwin` the store itself defaults to, and the
 * only thing it could get wrong is a path separator in an empty transcript.
 */
let platformOfHost: Platform = 'darwin';

/** Tell the pane layer what it is running on. Called once, from `bootstrap`. */
export function setHostPlatform(platform: Platform): void {
  platformOfHost = platform;
}

/**
 * What Artemis is running on.
 *
 * A plain read rather than a hook or a selector, because it is settled before
 * the first transcript draws and never moves again — subscribing to it would be
 * a subscription that can never fire. Callers who want a *reactive* platform
 * want the app store's copy; there is none, because there is no such thing.
 */
export function hostPlatform(): Platform {
  return platformOfHost;
}

/**
 * Whether thinking folds into activity markers, for panes not yet created.
 *
 * The same seam as {@link platformOfHost} above and for the same reason: this
 * is a *window* preference, the store owns it, and the store imports this
 * module — so the value is pushed down rather than read back up. The store
 * writes it before the first pane exists and again on every change; what it
 * covers is the pane minted afterwards, which would otherwise open folding the
 * reasoning away with the switch on.
 *
 * Live panes are told directly by `setShowThinking`, because their transcripts
 * already hold rows that have to be rebuilt.
 */
let thinkingFoldsInPanes = true;

/** Tell the pane layer how new transcripts should treat thinking. */
export function setThinkingFolds(folds: boolean): void {
  thinkingFoldsInPanes = folds;
}

/**
 * Teach a pane's transcript which of its tool calls made artifacts.
 *
 * A fresh closure every time, deliberately: `setArtifactTest` compares by
 * identity, so handing it a new function is what tells the model its cached
 * verdicts were taken against a working directory that has since moved.
 */
function installArtifactTest(pane: Pane): void {
  const cwd = pane.store.getState().cwd;
  const platform = hostPlatform();
  pane.transcript.setArtifactTest(
    (item) =>
      item.status === 'ok' &&
      detectArtifact(detectFileEdit(item.name, item.input), cwd, platform) !== null,
  );
}

/** Mint a pane around a starting state. The caller owns everything after this. */
export function createPane(initial: SessionState): Pane {
  nextPaneId += 1;
  const pane: Pane = {
    id: `pane${nextPaneId}`,
    store: createStore<SessionState>(() => initial),
    transcript: new TranscriptModel(),
  };
  installArtifactTest(pane);
  pane.transcript.setThinkingFolds(thinkingFoldsInPanes);
  return pane;
}

/** Mint a row around the panes it starts with. */
export function createRow(panes: readonly Pane[]): PaneRow {
  nextRowId += 1;
  return { id: `row${nextRowId}`, panes };
}

/** This pane's state, right now. The pane equivalent of `useApp.getState()`. */
export function paneState(pane: Pane): SessionState {
  return pane.store.getState();
}

/** Write a patch into a pane. Accepts an updater, exactly like zustand's. */
export function setPaneState(
  pane: Pane,
  patch: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>),
): void {
  const before = pane.store.getState().cwd;
  pane.store.setState(patch as never);
  // Whether a written file is an artifact is asked *relative to* `cwd`, so a
  // pane that moves has to ask again. This is the one funnel every write to a
  // live pane goes through, which is why the re-arm hangs here rather than on
  // each of the several callers that can move a directory.
  if (pane.store.getState().cwd !== before) installArtifactTest(pane);
}
