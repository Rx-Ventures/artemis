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
  readonly quickModelIds: readonly string[];
}

/** Every mirrored key, exactly once. The compiler enforces "exactly". */
export const MIRRORED_KEYS: readonly (keyof MirroredState)[] = [
  'providers',
  'profiles',
  'sessions',
  'contextWindows',
  'quickModelIds',
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
 * The regular shapes fall out of that rather than being special-cased: four
 * across is one row of four, four down is four rows of one, and a square is two
 * rows of two.
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

/** Mint a pane around a starting state. The caller owns everything after this. */
export function createPane(initial: SessionState): Pane {
  nextPaneId += 1;
  return {
    id: `pane${nextPaneId}`,
    store: createStore<SessionState>(() => initial),
    transcript: new TranscriptModel(),
  };
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
  pane.store.setState(patch as never);
}
