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
   * The model catalogue the *account* actually offers, or `[]` before one has
   * been fetched.
   *
   * Separate from the provider descriptor's static `models` because the two
   * answer different questions: the descriptor says what this build of Libra
   * knows about, this says what the installed CLI, signed in as this profile,
   * is willing to run. {@link activeModels} prefers this and falls back to the
   * descriptor, so no caller has to know which one it got.
   *
   * Never persisted. A catalogue is a fact about a remote account at a moment
   * in time; caching one across restarts would show models an expired
   * subscription no longer has.
   */
  readonly models: readonly ProviderModelOption[];
  readonly modelsLoading: boolean;
  /**
   * Why the last catalogue fetch failed, or `null`.
   *
   * Set *alongside* whatever catalogue is already loaded rather than instead of
   * it — see {@link refreshModels}. The UI shows this as a note on a list that
   * is still there, not as an empty state.
   */
  readonly modelsError: string | null;
  /**
   * Model ids the user pinned to the status-line picker, in no particular
   * order — display order comes from the catalogue, not from this.
   *
   * Empty means "not curated", which {@link quickModels} renders as the whole
   * catalogue. That is not the same as "pinned nothing": a user who has never
   * opened settings must still get a usable picker, so there is no way to
   * express an intentionally empty quick list and no need for one.
   */
  readonly quickModelIds: readonly string[];
  /** Ask the next run to trade reasoning depth for latency, where supported. */
  readonly fastMode: boolean;
  /** Ask the next run to spend materially more compute, where supported. */
  readonly ultracode: boolean;
  /** How wide the transcript column may grow. */
  readonly conversationWidth: ConversationWidth;

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

/** The default reading width, and the fallback for a value that fails validation. */
export const DEFAULT_CONVERSATION_WIDTH: ConversationWidth = 'comfortable';

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'profiles',
  'models',
  'appearance',
  'permissions',
];

const CONVERSATION_WIDTHS: readonly ConversationWidth[] = ['comfortable', 'wide', 'full'];

interface Prefs {
  cwd?: string;
  activeProfileId?: string | null;
  activeProviderId?: ProviderId;
  permissionMode?: PermissionMode;
  model?: string | null;
  effort?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  settingsSection?: SettingsSection;
  quickModelIds?: readonly string[];
  fastMode?: boolean;
  ultracode?: boolean;
  conversationWidth?: ConversationWidth;
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
  };
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
    settingsSection: s.settingsSection,
    quickModelIds: s.quickModelIds,
    fastMode: s.fastMode,
    ultracode: s.ultracode,
    conversationWidth: s.conversationWidth,
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

  models: [],
  modelsLoading: false,
  modelsError: null,
  quickModelIds: prefs.quickModelIds ?? [],
  fastMode: prefs.fastMode ?? false,
  ultracode: prefs.ultracode ?? false,
  conversationWidth: prefs.conversationWidth ?? DEFAULT_CONVERSATION_WIDTH,

  sessions: [],
  sessionsScope: 'all',
  sessionsLoading: false,
  sessionsError: null,

  run: null,
  permissionQueue: [],
  banners: [],

  screen: 'chat',
  settingsSection: prefs.settingsSection ?? 'profiles',
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
export function activeModels(state: AppState): readonly ProviderModelOption[] {
  if (state.models.length > 0) return state.models;
  return activeProvider(state)?.models ?? NO_OPTIONS;
}

/**
 * The catalogue narrowed to the user's pinned models, in catalogue order.
 *
 * Memoised on the identity of its two inputs, and that is not an optimisation.
 * This is read through `useApp(selector)`, which decides whether to re-render
 * by comparing the result to the last one by identity; a `filter` returns a
 * fresh array every call, so an unmemoised version would report a change on
 * every store read and React would loop until it hit its update-depth ceiling.
 * Same hazard the {@link NO_OPTIONS} note describes, one level up.
 */
let quickCatalogue: readonly ProviderModelOption[] | null = null;
let quickIds: readonly string[] | null = null;
let quickResult: readonly ProviderModelOption[] = NO_OPTIONS;

export function quickModels(state: AppState): readonly ProviderModelOption[] {
  const catalogue = activeModels(state);
  const ids = state.quickModelIds;
  if (catalogue === quickCatalogue && ids === quickIds) return quickResult;

  // No picks means "not curated", not "picked nothing" — a user who has never
  // opened settings still needs a usable picker, so the whole catalogue stands
  // in. Filtering to nothing would leave the status line with a menu that opens
  // onto an empty list and no way to fix it from there.
  const next = ids.length === 0 ? catalogue : catalogue.filter((m) => ids.includes(m.id));

  quickCatalogue = catalogue;
  quickIds = ids;
  // A pinned set that matches nothing in the current catalogue (the ids came
  // from another provider, or the models were withdrawn) falls back the same
  // way an uncurated one does, for the same reason.
  quickResult = next.length === 0 ? catalogue : next;
  return quickResult;
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
export function selectedModelOption(state: AppState): ProviderModelOption | undefined {
  return activeModel(state);
}

/**
 * Whether the fast-mode toggle should be offered at all.
 *
 * False when no model is explicitly selected, and that is deliberate rather
 * than conservative-by-accident: with the provider default in force Libra does
 * not know which model will run, so it cannot know whether the flag would be
 * honoured. An enabled toggle that the run silently ignores is worse than a
 * disabled one with a reason attached — the user believes it took effect.
 */
export function fastModeAvailable(state: AppState): boolean {
  return selectedModelOption(state)?.supportsFastMode === true;
}

/** The same question for ultracode. Separate flag, separate answer. */
export function ultracodeAvailable(state: AppState): boolean {
  return selectedModelOption(state)?.supportsUltracode === true;
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

  // Deliberately after `booted`, and deliberately not awaited. Fetching the
  // catalogue spawns a provider subprocess; blocking the first paint on it
  // would trade a working window for a slightly better-labelled model picker,
  // and the picker has the descriptor's list to render in the meantime.
  void refreshModels();
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

/**
 * Guards against an out-of-order catalogue response.
 *
 * The fetch spawns a provider subprocess, so it is slow enough that a user can
 * switch profile twice before the first answer lands. Without a token the
 * slower reply wins by arriving last and the picker ends up showing an account
 * the user is no longer signed in as — the same staleness `loadSessionHistory`
 * guards against, with a counter instead of an id because there is no id here.
 */
let modelsRequestToken = 0;

/**
 * Fetch the model catalogue for the active provider and profile.
 *
 * Never throws and never leaves `modelsLoading` set. The failure path
 * deliberately keeps whatever catalogue is already loaded: this runs on every
 * profile switch, and a transient failure that emptied the list would take the
 * model picker away from under the user's cursor and replace it with a
 * "no models" state that is not true.
 */
export async function refreshModels(): Promise<void> {
  const { bridge } = resolveBridge();
  const state = useApp.getState();

  // No profile means no credential, and the catalogue is a property of the
  // account rather than of the binary — there is nothing to authenticate as, so
  // there is nothing to ask. The descriptor's built-in list stands until a
  // profile exists.
  const profileId = state.activeProfileId;
  if (!bridge || !profileId) return;

  const token = ++modelsRequestToken;
  useApp.setState({ modelsLoading: true, modelsError: null });

  try {
    const result = await call(() =>
      bridge.providers.models({
        providerId: state.activeProviderId,
        profileId,
        ...(state.cwd.trim().length > 0 ? { cwd: state.cwd } : {}),
      }),
    );

    if (token !== modelsRequestToken) return;

    if (!result.ok) {
      // Not a banner. The picker still has a list to render — either a stale
      // live one or the descriptor's — so this is a footnote on a working
      // control, not an error the user has to dismiss.
      useApp.setState({ modelsError: result.error.message });
      return;
    }

    // `live: false` is the handler saying "this is the built-in list, nobody
    // confirmed it". Storing it anyway would make `activeModels` prefer a copy
    // of the descriptor over the descriptor, which is harmless but makes
    // "did the account answer?" unanswerable downstream. So only a confirmed
    // catalogue is stored, and the fallback stays the descriptor's own list.
    if (result.value.live) {
      useApp.setState({ models: result.value.models, modelsError: null });
    } else {
      useApp.setState({ modelsError: null });
    }
  } finally {
    // In a `finally` because an early `return` above still has to clear the
    // spinner; only the newest request owns it, or a superseded reply would
    // stop the indicator for a fetch that is still running.
    if (token === modelsRequestToken) useApp.setState({ modelsLoading: false });
  }
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
    // Cleared, unlike on a profile switch: a catalogue belongs to a provider,
    // and leaving the old one loaded would have `activeModels` hand the new
    // provider's picker a list of models it cannot run. The descriptor's own
    // list covers the gap until the fetch lands.
    models: [],
    modelsError: null,
  }));
  savePrefs();
  void refreshSessions();
  void refreshModels();
}

export function setProfile(profileId: ProfileId): void {
  useApp.setState({ activeProfileId: profileId });
  savePrefs();
  void refreshSessions();
  // The catalogue is not cleared first. The provider is the same, so the loaded
  // list is still the right shape of answer and is very likely the same one;
  // showing it until the new account replies beats flashing the picker back to
  // the built-in list and forward again.
  void refreshModels();
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
export function setFastMode(on: boolean): void {
  useApp.setState(on ? { fastMode: true, ultracode: false } : { fastMode: false });
  savePrefs();
}

/** The same, for ultracode. @see setFastMode for why the two are exclusive. */
export function setUltracode(on: boolean): void {
  useApp.setState(on ? { ultracode: true, fastMode: false } : { ultracode: false });
  savePrefs();
}

/* -------------------------------------------------------------------------- */
/* Appearance                                                                 */
/* -------------------------------------------------------------------------- */

export function setConversationWidth(width: ConversationWidth): void {
  useApp.setState({ conversationWidth: width });
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
    // Same rule as `setProvider`: a catalogue belongs to a provider, so
    // landing on a different one has to drop it rather than show the previous
    // provider's models under the new one's name.
    ...(state.activeProviderId === session.providerId ? {} : { models: [], modelsError: null }),
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
  void refreshModels();
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
  // A new profile is a new account, and the catalogue is a property of the
  // account — the freshly created one may well be the first that can answer at
  // all, since `refreshModels` no-ops without a profile.
  void refreshModels();
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
  if (next.scope !== 'delta' || !previous) return next;
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
      useApp.setState((s) => ({
        run: s.run ? { ...s.run, usage: mergeUsage(s.run.usage, event.usage) } : s.run,
      }));
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
