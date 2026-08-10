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
 */

import { create } from 'zustand';
import { NO_CAPABILITIES } from '@libra/protocol';
import type {
  AgentError,
  AgentEvent,
  Capabilities,
  IpcError,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionScope,
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
} from '@libra/protocol';
import { call, resolveBridge, type BridgeMode } from '../lib/bridge';
import {
  listSessionsEverywhere,
  pickDirectory,
  type DirectoryChoice,
  type SessionScope,
} from '../lib/extensions';
import { isAbsolutePath } from '../lib/paths';
import { newId } from '../lib/id';
import { TranscriptModel } from './transcript';

/** The one transcript instance. Components subscribe to it directly. */
export const transcript = new TranscriptModel();

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type Screen = 'chat' | 'profiles';

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

  readonly providers: readonly ProviderDescriptor[];
  readonly profiles: readonly ProfileMetadata[];
  readonly activeProviderId: ProviderId;
  readonly activeProfileId: ProfileId | null;

  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  /**
   * Model id for the next run, or `null` for the provider's default.
   *
   * Held as a plain id rather than a `ProviderModelOption` because it is
   * persisted across restarts and across provider switches, where the option
   * object may no longer exist. Every read resolves it against the live
   * descriptor — see {@link activeModel}.
   */
  readonly model: string | null;
  /** Reasoning-effort id for the next run, or `null` for the provider default. */
  readonly effort: string | null;
  readonly forkOnResume: boolean;
  readonly resumeSessionId: SessionId | null;

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

  readonly run: RunState | null;
  /**
   * Context window size per model, learned as runs finish.
   *
   * The provider only reveals a model's window in the `final` usage snapshot at
   * run end, and `run` resets every turn — so without somewhere durable to keep
   * it, the context readout can never render while a turn is streaming. Keyed
   * by model because the number is a property of the model, not the session:
   * switching models must not show the previous one's window.
   */
  readonly contextWindows: Readonly<Record<string, number>>;
  /**
   * Permission requests still awaiting an answer.
   *
   * Kept alongside the transcript's own permission items, which carry the
   * *record* of a decision. This list is the live work queue: it drives the
   * run's `awaiting_permission` status and the status line's counter, and it is
   * what tells Escape which request to deny.
   */
  readonly permissionQueue: readonly PermissionRequest[];
  readonly banners: readonly Banner[];

  readonly screen: Screen;
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
   * Prompts the user has sent this session, newest last.
   *
   * Kept so an empty composer can recall the previous prompt with Up, the way
   * a shell does. Renderer-local and never persisted: a prompt history that
   * survived a restart would be a second place a user's text lives, and this
   * one has no business outliving the window.
   */
  readonly promptHistory: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

const PREFS_KEY = 'libra.prefs.v1';

/** Sidebar width bounds. Narrower than the minimum stops being a list. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 460;
export const SIDEBAR_DEFAULT_WIDTH = 272;

/** Keep a width inside the bounds, and reject anything that is not a number. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

interface Prefs {
  cwd?: string;
  activeProfileId?: string | null;
  activeProviderId?: ProviderId;
  permissionMode?: PermissionMode;
  model?: string | null;
  effort?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
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

function loadPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
}

function savePrefs(): void {
  const s = useApp.getState();
  const prefs: Prefs = {
    cwd: s.cwd,
    activeProfileId: s.activeProfileId,
    activeProviderId: s.activeProviderId,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarWidth: s.sidebarWidth,
    contextWindows: s.contextWindows,
  };
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Preferences are a convenience; a full quota is not worth an error. */
  }
}

const prefs = loadPrefs();

export const useApp = create<AppState>(() => ({
  bridgeMode: 'unavailable',
  version: '',
  platform: 'darwin',
  booted: false,

  providers: [],
  profiles: [],
  activeProviderId: prefs.activeProviderId ?? 'claude',
  activeProfileId: prefs.activeProfileId ?? null,

  cwd: prefs.cwd ?? '',
  permissionMode: prefs.permissionMode ?? 'default',
  model: prefs.model ?? null,
  effort: prefs.effort ?? null,
  forkOnResume: false,
  resumeSessionId: null,

  sessions: [],
  sessionsScope: 'all',
  sessionsLoading: false,
  sessionsError: null,

  run: null,
  contextWindows: prefs.contextWindows ?? {},
  permissionQueue: [],
  banners: [],

  screen: 'chat',
  paletteOpen: false,
  infoOpen: false,
  promptHistory: [],

  sidebarCollapsed: prefs.sidebarCollapsed ?? false,
  sidebarWidth: clampSidebarWidth(prefs.sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH),
}));

/* -------------------------------------------------------------------------- */
/* Selectors                                                                  */
/* -------------------------------------------------------------------------- */

/** The descriptor for the provider the UI is currently pointed at. */
export function activeProvider(state: AppState): ProviderDescriptor | undefined {
  return state.providers.find((p) => p.id === state.activeProviderId);
}

/**
 * Capabilities the UI should degrade against.
 *
 * A live run keeps the capabilities it was started with, so switching the
 * provider selector mid-run cannot retroactively change what the run can do.
 */
export function activeCapabilities(state: AppState): Capabilities {
  if (state.run && state.run.status !== 'ended') return state.run.capabilities;
  return activeProvider(state)?.capabilities ?? NO_CAPABILITIES;
}

/** Human name for the provider being degraded against, for tooltips. */
export function activeProviderLabel(state: AppState): string {
  return activeProvider(state)?.label ?? state.activeProviderId;
}

/** True when a run is accepting events. */
export function isLive(state: AppState): boolean {
  return state.run !== null && state.run.status !== 'ended';
}

export function activeProfile(state: AppState): ProfileMetadata | undefined {
  return state.profiles.find((p) => p.id === state.activeProfileId);
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
 * Empty means "no model choice", which the picker renders as a disabled
 * segment with that as its reason rather than as an empty menu — the same rule
 * every other capability-driven control follows.
 */
export function activeModels(state: AppState): readonly ProviderModelOption[] {
  return activeProvider(state)?.models ?? NO_OPTIONS;
}

/** Reasoning-effort levels the active provider offers, least to most. */
export function activeEffortLevels(state: AppState): readonly ProviderEffortOption[] {
  return activeProvider(state)?.effortLevels ?? NO_OPTIONS;
}

/**
 * The model the next run will actually use.
 *
 * `null` when the stored preference names something this provider does not
 * offer — which happens routinely, because the preference survives a provider
 * switch. Callers render that as "provider default" rather than echoing a model
 * id the run will not use.
 */
export function activeModel(state: AppState): ProviderModelOption | undefined {
  const models = activeModels(state);
  return models.find((m) => m.id === state.model) ?? undefined;
}

/** The effort level the next run will actually use, resolved the same way. */
export function activeEffort(state: AppState): ProviderEffortOption | undefined {
  return activeEffortLevels(state).find((e) => e.id === state.effort) ?? undefined;
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
export function lastKnownBranch(state: AppState): string | undefined {
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
export function pendingPermission(state: AppState): PermissionRequest | undefined {
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

export async function bootstrap(): Promise<void> {
  const { mode, bridge } = resolveBridge();
  useApp.setState({
    bridgeMode: mode,
    version: bridge?.version ?? '',
    platform: bridge?.platform ?? 'darwin',
  });

  if (!bridge) {
    useApp.setState({ booted: true });
    return;
  }

  await Promise.all([refreshProviders(), refreshProfiles()]);
  await adoptExistingRun();
  await refreshSessions();
  useApp.setState({ booted: true });
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
  useApp.setState((s) => {
    const stillThere = providers.some((p) => p.id === s.activeProviderId);
    const firstAvailable = providers.find((p) => p.available) ?? providers[0];
    return {
      providers,
      activeProviderId: stillThere ? s.activeProviderId : (firstAvailable?.id ?? s.activeProviderId),
    };
  });
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
  useApp.setState((s) => ({
    profiles,
    activeProfileId:
      s.activeProfileId && profiles.some((p) => p.id === s.activeProfileId)
        ? s.activeProfileId
        : (profiles.find((p) => p.providerId === s.activeProviderId)?.id ?? profiles[0]?.id ?? null),
  }));
  savePrefs();
}

/** Re-attach to a run the main process still considers live after a reload. */
async function adoptExistingRun(): Promise<void> {
  const { bridge } = resolveBridge();
  const state = useApp.getState();
  if (!bridge || !state.cwd) return;
  const result = await call(() => bridge.runs.list({ cwd: state.cwd }));
  if (!result.ok) return;
  const live = result.value.runs.find((r) => r.status !== 'ended');
  if (!live) return;
  useApp.setState({ run: fromHandle(live) });
  transcript.note(
    'info',
    `Re-attached to run ${live.runId.slice(0, 8)}… already in progress`,
    'Events emitted before this window loaded are not replayed.',
  );
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

export function setProvider(providerId: ProviderId): void {
  useApp.setState((s) => ({
    activeProviderId: providerId,
    activeProfileId:
      s.profiles.find((p) => p.id === s.activeProfileId)?.providerId === providerId
        ? s.activeProfileId
        : (s.profiles.find((p) => p.providerId === providerId)?.id ?? null),
    sessions: [],
  }));
  savePrefs();
  void refreshSessions();
}

export function setProfile(profileId: ProfileId): void {
  useApp.setState({ activeProfileId: profileId });
  savePrefs();
  void refreshSessions();
}

export function setCwd(cwd: string): void {
  useApp.setState({ cwd: cwd.trim() });
  savePrefs();
  void refreshSessions();
}

/**
 * Open the host's folder chooser and adopt what comes back.
 *
 * Returns the outcome rather than reporting it, so the control that opened the
 * dialog can render the failure *on itself*. A native picker that refuses — the
 * path is not a directory, the dialog could not open — has a specific reason,
 * and the caller shows that reason verbatim instead of "something went wrong".
 */
export async function chooseWorkingDirectory(): Promise<DirectoryChoice> {
  const choice = await pickDirectory(useApp.getState().cwd);
  if (choice.status === 'chosen') setCwd(choice.path);
  return choice;
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

export function setPermissionMode(mode: PermissionMode): void {
  useApp.setState({ permissionMode: mode });
  savePrefs();
}

/** Choose the model for the next run. `null` means the provider's default. */
export function setModel(model: string | null): void {
  useApp.setState({ model });
  savePrefs();
}

/** Choose the reasoning effort for the next run. `null` means the default. */
export function setEffort(effort: string | null): void {
  useApp.setState({ effort });
  savePrefs();
}

export function setForkOnResume(fork: boolean): void {
  useApp.setState({ forkOnResume: fork });
}

export function setScreen(screen: Screen): void {
  useApp.setState({ screen, paletteOpen: false });
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

export async function refreshSessions(): Promise<void> {
  const { bridge } = resolveBridge();
  const state = useApp.getState();

  // `listSessions` gates the whole list. Cleared rather than left stale: a
  // provider that cannot enumerate history has none to show, and the sidebar
  // renders the capability's own reason in place of the rows.
  if (!bridge || !activeCapabilities(state).listSessions) {
    useApp.setState({ sessions: [], sessionsError: null, sessionsLoading: false });
    return;
  }

  useApp.setState({ sessionsLoading: true, sessionsError: null });
  const listing = await listSessionsEverywhere({
    providerId: state.activeProviderId,
    profileId: state.activeProfileId,
    cwd: state.cwd,
    limit: SESSION_PAGE_SIZE,
  });

  useApp.setState({
    sessionsLoading: false,
    sessions: listing.sessions,
    sessionsScope: listing.scope,
    sessionsError: listing.error ?? null,
  });
}

/** Start a blank transcript. Disposes whatever run is live. */
export function newSession(): void {
  void disposeRun();
  transcript.reset();
  useApp.setState({ run: null, resumeSessionId: null, permissionQueue: [], paletteOpen: false });
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
 */
export function resumeSession(session: SessionSummary): void {
  const state = useApp.getState();

  const profile = state.profiles.find((p) => p.id === session.profileId);
  if (!profile) {
    pushBanner(
      'error',
      'That session’s profile no longer exists',
      'A session lives inside the profile that created it, so it cannot be resumed from another one.',
    );
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

  void disposeRun();
  transcript.reset();
  useApp.setState({
    run: null,
    activeProviderId: session.providerId,
    activeProfileId: session.profileId,
    cwd: session.cwd,
    resumeSessionId: session.id,
    forkOnResume: false,
    permissionQueue: [],
    paletteOpen: false,
  });
  savePrefs();

  const moved = [
    switchedProfile ? `profile → ${profile.label}` : '',
    switchedCwd ? `directory → ${session.cwd}` : '',
  ].filter(Boolean);

  if (moved.length > 0) {
    transcript.note(
      'info',
      `Continuing "${session.title}"`,
      `Switched ${moved.join(' and ')}, because a session only resumes under the profile and directory it was created in.`,
    );
  }

  void loadSessionHistory(session);
  void refreshSessions();
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
async function loadSessionHistory(session: SessionSummary): Promise<void> {
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
  // wrong conversation, so drop it.
  if (useApp.getState().resumeSessionId !== session.id) return;

  if (!res.ok) {
    // Non-fatal: the session still resumes, the user just cannot see what came
    // before. Say so rather than leaving an unexplained empty pane.
    transcript.note(
      'warn',
      'Could not load earlier messages',
      `${res.error.message} The session will still continue from where it left off.`,
    );
    return;
  }

  for (const event of res.value.events) transcript.apply(event);

  if (res.value.hasMore) {
    transcript.note('info', 'Showing the most recent part of this session', undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

/** How many prompts Up-arrow can walk back through. */
const MAX_PROMPT_HISTORY = 100;

/** Append to the recall history, collapsing an immediate repeat. */
function rememberPrompt(prompt: string): void {
  useApp.setState((s) => {
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

export async function submitPrompt(text: string): Promise<void> {
  const prompt = text.trim();
  if (prompt.length === 0) return;

  const { bridge } = resolveBridge();
  const state = useApp.getState();
  if (!bridge) {
    pushBanner('error', 'No bridge to the main process', 'The preload script did not load.');
    return;
  }
  if (!state.activeProfileId) {
    pushBanner('error', 'Pick a profile first', 'A run needs credentials, which come from a profile.');
    setScreen('profiles');
    return;
  }
  if (state.cwd.trim().length === 0) {
    pushBanner('error', 'Set a working directory', 'The agent needs an absolute path to work in.');
    return;
  }

  // Recorded before the send is attempted. Up-arrow recall is about getting a
  // prompt back, and the prompt you most want back is the one that just failed
  // to go anywhere.
  rememberPrompt(prompt);

  const live = isLive(state) ? state.run : null;

  if (live) {
    if (!live.capabilities.midRunSteering) {
      pushBanner('warn', 'This provider cannot take input mid-run');
      return;
    }
    const steerId = transcript.pushUserMessage(prompt);
    const result = await call(() => bridge.runs.send({ runId: live.runId, text: prompt }));
    if (!result.ok) {
      reportFailure('Could not deliver the message', result.error);
      return;
    }
    transcript.confirmUserMessage(steerId);
    if (!result.value.deliveredImmediately) {
      transcript.note(
        'info',
        'Queued — the provider decides when this takes effect.',
        'It steers the current turn if the provider can fold it in, and otherwise waits for the next one.',
      );
    }
    return;
  }

  const runId = newId('run');
  const capabilities = activeCapabilities(state);
  const promptId = transcript.pushUserMessage(prompt);
  useApp.setState({
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

  const input: RunInput = {
    providerId: state.activeProviderId,
    profileId: state.activeProfileId,
    cwd: state.cwd,
    prompt,
    runId,
    includePartialMessages: capabilities.partialMessages,
    ...(model ? { model: model.id } : {}),
    ...(effort ? { effort: effort.id } : {}),
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
    endRunLocally(runId, 'error', result.error);
    return;
  }
  transcript.confirmUserMessage(promptId);
  mergeHandle(result.value.run);
}

function mergeHandle(handle: RunHandle): void {
  useApp.setState((s) => {
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
function endRunLocally(runId: RunId, reason: RunEndReason, error?: AgentError): void {
  useApp.setState((s) =>
    s.run && s.run.runId === runId
      ? { run: { ...s.run, status: 'ended', endReason: reason, ...(error ? { error } : {}) } }
      : {},
  );
  transcript.localRunEnd(reason, error);
}

export async function interruptRun(): Promise<void> {
  const { bridge } = resolveBridge();
  const run = useApp.getState().run;
  if (!bridge || !run || run.status === 'ended') return;
  const result = await call(() => bridge.runs.interrupt({ runId: run.runId }));
  if (!result.ok) {
    reportFailure('Could not interrupt the run', result.error);
    return;
  }
  const queued = result.value.stillQueued ?? [];
  if (queued.length > 0) {
    transcript.note('warn', `${queued.length} queued message(s) will still run.`);
  }
}

export async function disposeRun(): Promise<void> {
  const { bridge } = resolveBridge();
  const run = useApp.getState().run;
  if (!bridge || !run) return;
  await call(() => bridge.runs.dispose({ runId: run.runId }));
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/** Take one request off the queue, clearing `awaiting_permission` when it empties. */
function dropPermissionRequest(requestId: string): void {
  useApp.setState((s) => {
    const permissionQueue = s.permissionQueue.filter((r) => r.id !== requestId);
    const run =
      s.run && s.run.status === 'awaiting_permission' && permissionQueue.length === 0
        ? { ...s.run, status: 'running' as RunStatus }
        : s.run;
    return { permissionQueue, run };
  });
}

/**
 * Answer a permission prompt.
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
): Promise<string | null> {
  const { bridge } = resolveBridge();
  const run = useApp.getState().run;
  if (!bridge || !run) return null;

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
      transcript.resolvePermission(requestId, 'denied', result.error.message);
      dropPermissionRequest(requestId);
    }
    return result.error.message;
  }

  transcript.resolvePermission(
    requestId,
    decision.behavior === 'allow' ? 'allowed' : 'denied',
    decision.behavior === 'deny' ? decision.message : describeScope(decision.scope),
  );

  dropPermissionRequest(requestId);
  return null;
}

/** Neutral denial handed back to the model when the user gives no reason. */
export const DEFAULT_DENIAL = 'The user denied this tool call.';

/**
 * Deny the oldest outstanding prompt.
 *
 * Bound to Escape, which therefore means "deny" while anything is parked and
 * "interrupt the run" otherwise. Denying is the safe answer *and* it unblocks
 * the provider, so the reflex to press Escape resolves the run instead of
 * stranding it — the same reasoning the modal used, kept now that the prompt is
 * inline and Escape is no longer captured by an overlay.
 *
 * @returns true when there was something to deny.
 */
export async function denyPendingPermission(): Promise<boolean> {
  const request = pendingPermission(useApp.getState());
  if (!request) return false;
  await respondToPermission(request.id, { behavior: 'deny', message: DEFAULT_DENIAL });
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
 * `draft.apiKey` is the single place a plaintext secret crosses IPC, and it
 * only ever travels renderer → main. Callers must read the key straight out of
 * an uncontrolled input at submit time and never park it in React state; see
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
  useApp.setState({ activeProfileId: result.value.profile.id });
  savePrefs();
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
  if (result.value.configDirDeleted) {
    pushBanner('info', 'Profile and its session history were deleted');
  }
  await refreshProfiles();
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

export function handleAgentEvent(event: AgentEvent): void {
  const state = useApp.getState();
  const run = state.run;
  // Events are multiplexed across every run the main process is driving; this
  // window renders one at a time and ignores the rest rather than interleaving.
  if (!run || run.runId !== event.runId) return;

  transcript.apply(event);

  switch (event.type) {
    case 'session.started':
      useApp.setState({
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
      break;

    case 'permission.request':
      useApp.setState((s) => ({
        permissionQueue: [...s.permissionQueue, event.request],
        run: s.run ? { ...s.run, status: 'awaiting_permission' } : s.run,
      }));
      break;

    case 'usage':
      useApp.setState((s) => {
        if (!s.run) return { run: s.run };
        const model = s.run.model;
        const learned = event.usage.contextWindow;
        return {
          run: { ...s.run, usage: mergeUsage(s.run.usage, event.usage) },
          ...(learned !== undefined && model !== undefined && s.contextWindows[model] !== learned
            ? { contextWindows: { ...s.contextWindows, [model]: learned } }
            : {}),
        };
      });
      break;

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
      const endedSessionId = event.sessionId ?? run.sessionId;
      const resumable =
        run.capabilities.resumeSession &&
        endedSessionId !== undefined &&
        state.cwd === run.cwd &&
        state.activeProfileId === run.profileId;

      useApp.setState((s) => ({
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
      void refreshSessions();
      break;
    }

    default:
      break;
  }
}
