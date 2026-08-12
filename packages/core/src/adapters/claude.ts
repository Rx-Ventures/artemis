/**
 * The Claude provider adapter — the seam's reference implementation.
 *
 * This file is the plumbing; `./mapper.ts` is the meaning. Everything here is
 * about driving `@anthropic-ai/claude-agent-sdk` correctly and tearing it down
 * without leaking a subprocess.
 *
 * ## Streaming input is not optional
 *
 * `query()` accepts either a `string` prompt or an `AsyncIterable<SDKUserMessage>`.
 * Artemis must always use the iterable form, for two reasons that are easy to miss
 * from the type signature alone:
 *
 *  1. **There is no `send()` on `Query`.** Multi-turn input works by pushing
 *     more `SDKUserMessage`s into the prompt iterable. So `Run.send()` is
 *     implemented as a push onto {@link AsyncQueue}, and the iterable must stay
 *     open across the turn — a naive generator that yields the prompt and
 *     returns would close the input stream and make steering impossible.
 *  2. **Every control method requires it.** `interrupt()`, `setModel()`,
 *     `setPermissionMode()` and friends are documented as "only available in
 *     streaming input mode". Using a string prompt would silently cost us the
 *     Stop button.
 *
 * ## What a run is
 *
 * One run is **one turn cycle**: a prompt, whatever the agent does about it,
 * and the `result` message that closes it. `run.end` fires there, and the
 * caller continues the conversation by starting a *new* run with
 * `resumeSessionId` set to the id `run.end` reported. `Run.send()` steers the
 * turn that is already in flight; it is not "send the next message".
 *
 * ## Configuration isolation
 *
 * `settingSources` defaults to `[]`. Artemis is a third-party desktop app, and
 * silently merging the user's `~/.claude` configuration would import their
 * hooks, MCP servers and permission rules into an app they never granted them
 * to. Callers opt in per run. `./env.ts` does the matching job for environment
 * variables: every credential variable Claude understands is stripped from the
 * inherited environment, so the profile — and only the profile — decides which
 * account authenticates and which one is billed. See {@link CLAUDE_CREDENTIALS}
 * for the two auth modes and why an inherited `ANTHROPIC_API_KEY` is the
 * dangerous case rather than a harmless one.
 */

import { isAbsolute } from 'node:path';

import {
  deleteSession as sdkDeleteSession,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query,
  renameSession as sdkRenameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  ModelInfo,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  Settings,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
/*
 * The message-content types the SDK builds `SDKUserMessage.message` out of, but
 * does not re-export: it imports them from `@anthropic-ai/sdk/resources` and
 * keeps them internal. Reached for directly, therefore, and type-only — nothing
 * here survives compilation, and the package is already in the tree as the
 * Agent SDK's own dependency.
 */
import type {
  ContentBlockParam,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources';

import type {
  AgentError,
  AgentEvent,
  Attachment,
  Capabilities,
  JsonObject,
  PermissionDecision,
  PermissionRequestId,
  PermissionResolvedEvent,
  PlanUsage,
  ProfileId,
  ProviderEffortOption,
  ProviderModelOption,
  QuestionAnswer,
  QuestionPrompt,
  RunEndReason,
  RunStatus,
  SessionId,
  SessionSummary,
  SystemPromptSpec,
} from '@rx-artemis/protocol';
import {
  isFileAttachment,
  isImageAttachment,
  isPdf,
  NO_CAPABILITIES,
  PDF_MEDIA_TYPE,
} from '@rx-artemis/protocol';

import {
  createStagingDirectory,
  describeStagedAttachments,
  removeStagingDirectory,
  stageAttachments,
  withAttachmentNote,
} from './attachments.js';
import type { StagedAttachment } from './attachments.js';

import { checkWorkingDirectory } from '../workspace/workdir.js';
import { CLAUDE_ENV_SCRUB_KEYS, composeProviderEnv, readEnv } from './env.js';
import {
  CLAUDE_PROVIDER_ID,
  DISPOSED_DENY_MESSAGE,
  WITHDRAWN_DENY_MESSAGE,
  buildPermissionRequest,
  createClaudeMapperState,
  finalizeRun,
  mapAggregatedSessionInfo,
  mapSdkMessage,
  mapSessionInfo,
  nextEventEnvelope,
  toPermissionResult,
} from './mapper.js';
import type { ClaudeMapperState } from './mapper.js';
import { replayStoredSession } from './history.js';
import type { StoredMessage } from './history.js';
import { readPlanUsage } from './planUsage.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import {
  SESSION_TITLE_INSTRUCTIONS,
  buildTitlePrompt,
  cleanSessionTitle,
  isDeclinedTitle,
} from './titles.js';
import {
  adapterError,
  toAgentError,
  scrubSecrets,
} from './types.js';
import type {
  AdapterAvailability,
  AggregatedSessionList,
  AllSessionsQuery,
  EnvBundle,
  InterruptResult,
  ModelCatalogue,
  ModelListQuery,
  PlanUsageQuery,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionDeleteQuery,
  SessionListPage,
  SessionListQuery,
  SessionMessageCountQuery,
  SessionMessagesQuery,
  SessionTitleQuery,
  SessionTitleUpdate,
  SessionTranscript,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the Claude provider can do.
 *
 * Built by spreading `NO_CAPABILITIES` so that a capability added to the
 * protocol later defaults to "unsupported" instead of breaking the build with a
 * missing property — and, more importantly, so it defaults to the *safe* answer
 * rather than an optimistic one.
 */
export const CLAUDE_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true, // `canUseTool`
  partialMessages: true, // `includePartialMessages` + `stream_event` messages
  midRunSteering: true, // the streaming-input prompt iterable
  forkSession: true, // `Options.forkSession`
  listSessions: true, // the SDK's `listSessions({ dir })`
  subagents: true, // `parent_tool_use_id` / `agentID`
  renameSession: true, // the SDK's `renameSession(id, title)`
  deleteSession: true, // the SDK's `deleteSession(id)` — unlinks the transcript

  permissionModes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  resumeSession: true, // `Options.resume`
  usageReporting: true, // `result.usage` / `result.modelUsage`
  costReporting: true, // `total_cost_usd` / `ModelUsage.costUSD`
  planUsageReporting: true, // the SDK's structured `/usage` control request
  imageInput: true, // base64 `image` blocks in the user message's content
  fileInput: true, // staged to a granted temp directory and named in the prompt
};

/** Env var selecting an isolated Claude config — and therefore session — directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Env vars that authenticate the Claude CLI *without* going through the config
 * directory — and therefore the exact set Artemis has to keep unset.
 *
 * Each of these outranks the credential the config directory holds. An
 * `ANTHROPIC_API_KEY` exported in the user's shell beats the subscription their
 * profile is signed into and bills metered API usage instead; that failure is
 * silent, arrives on the bill rather than on screen, and is indistinguishable
 * from "account switching does not work".
 *
 * Artemis sets none of them, in any circumstance, and strips all of them from
 * every run's inherited environment.
 */
export const CLAUDE_CREDENTIAL_ENVS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * How a Claude profile's environment is scoped, and how it gets signed in.
 *
 * This is Claude's vocabulary and it lives with Claude's adapter. Everything
 * here is read by the Claude CLI and nothing else — `CLAUDE_CONFIG_DIR`, the
 * credential variables that would override it, and the `claude auth …` argv.
 *
 * ## One directory, one account
 *
 * `CLAUDE_CONFIG_DIR` scopes the *credential*, not merely settings. Verified on
 * macOS, same machine, same moment:
 *
 *     CLAUDE_CONFIG_DIR=<temp>  →  { loggedIn: false, authMethod: 'none' }
 *     (ambient)                 →  { loggedIn: true,  subscriptionType: 'max' }
 *
 * So a login performed with it set belongs to that directory alone, which is
 * the entire isolation mechanism: one profile, one directory, one account, one
 * history. (The official docs describe macOS credentials as living in the
 * Keychain, which reads as though a config directory could not isolate them.
 * The observed behaviour above says otherwise, and it is what this is built on.)
 *
 * ## Why Artemis emits no credential
 *
 * It used to. A profile held a pasted API key or subscription token and this
 * spec named the variable to write it into. Two things were wrong with that,
 * and neither was fixable while Artemis held the credential: the secret sat in
 * Artemis's own store, and `ANTHROPIC_API_KEY` *overrides* a subscription login,
 * so a profile meant to bill a plan could silently bill API credit instead.
 *
 * Now the CLI's own per-profile login supplies the credential and Artemis emits
 * none of the three variables that could compete with it — it only strips them.
 * A stale value in the user's shell cannot beat a good login, because there is
 * no case in which one of these variables survives into a run.
 */
export const CLAUDE_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: CLAUDE_CONFIG_DIR_ENV,
  credentialEnvKeys: [...CLAUDE_CREDENTIAL_ENVS],
  signIn: {
    executable: 'claude',
    /*
      No `--claudeai` flag, though it exists and would be equivalent.

      Subscription is the CLI's own default, and this argv is rendered into a
      command the *user* reads and runs. A flag that only restates the default
      is one more thing to explain in a line that has to survive being pasted
      into a terminal.

      `--console` is deliberately not offered. Artemis supports plan-billed
      accounts, so a mode picker with one entry is a picker that only teaches
      the user there was a decision to get wrong.
    */
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    logoutArgs: ['auth', 'logout'],
    howTo:
      'Run this in a terminal. It opens your browser, signs in to your Claude account, and writes the credential into this profile’s config directory — nothing passes through Artemis. Artemis watches that directory and continues on its own once you are done.',
  },
};

/**
 * Claude's families, smallest first, as {@link ProviderModelOption.tier}.
 *
 * This is the one place in Artemis that is allowed to know that `haiku` is
 * smaller than `opus`, and it is here for the reason every other model fact is:
 * a family name is the provider's vocabulary. The protocol carries an ordinal
 * and no opinion; the adapter supplies the opinion.
 *
 * Families rather than models, because the tier has to survive the live
 * catalogue. That list arrives with ids this build has never seen —
 * `claude-haiku-4-6`, a snapshot, a bracketed variant — and the family is the
 * part of the id that keeps meaning what it meant. A family missing from this
 * table gets **no tier at all** rather than a guessed one: `lowestTierModel`
 * treats unknown as "do not spend on this", which is the correct answer for a
 * model nobody here can place.
 */
const CLAUDE_FAMILY_TIERS = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
  fable: 3,
} as const satisfies Readonly<Record<string, number>>;

/**
 * The tier of a Claude model id, or `undefined` for a family we do not know.
 *
 * Reads the family off the wire id by the same rules {@link shortModelName}
 * uses — strip the vendor prefix, the dated snapshot suffix and the bracketed
 * variant — because those three decorations are exactly what stands between
 * `claude-haiku-4-5-20251001` and the word `haiku`.
 */
export function claudeModelTier(id: string | undefined): number | undefined {
  if (id === undefined) return undefined;
  const family = id
    .trim()
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .split('-')[0];
  if (family === undefined) return undefined;
  return (CLAUDE_FAMILY_TIERS as Readonly<Record<string, number>>)[family];
}

/**
 * Models the picker falls back to, in display order. First entry is the default.
 *
 * **This list is a fallback, not the catalogue.** The authoritative list comes
 * off the installed CLI at runtime via {@link fetchClaudeModels}, which asks
 * the SDK's `supportedModels()` and gets back the real lineup with the
 * provider's own display names, per-model effort levels and per-model fast-mode
 * support. That is the list the UI should show.
 *
 * This exists because the fetch can fail — no binary, no credential, an offline
 * machine — and a model picker that renders empty is worse than one that
 * renders slightly stale. Everything here is therefore deliberately
 * conservative: aliases rather than dated snapshots, and capability flags set
 * only where they are structural rather than guessed. Live data overwrites all
 * of it, field by field.
 *
 * **Aliases, not dated snapshot ids.** `sonnet` resolves to whatever the
 * installed CLI considers the current Sonnet; `claude-sonnet-4-5-20250929` is
 * frozen and goes stale in a way nobody notices until a run fails. A picker
 * that has to be edited on every model release is a picker that will be wrong —
 * which is the same reasoning that makes the live fetch the primary path.
 *
 * This list is what the UI *offers*. It is not an allow-list: `RunInput.model`
 * stays open, so a user or a future settings screen can still name a specific
 * snapshot and have it passed straight through — see {@link validateRunInput},
 * which deliberately does not check it.
 */
export const CLAUDE_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'fable',
    label: 'Fable 5',
    displayName: 'Claude Fable 5',
    resolvedModel: 'claude-fable-5',
    note: 'Highest reasoning ceiling. Takes every effort level, including max.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.fable,
  },
  {
    id: 'opus',
    label: 'Opus 5',
    displayName: 'Claude Opus 5',
    resolvedModel: 'claude-opus-5',
    note: 'The most capable general model. Slowest and most expensive per token.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsFastMode: true,
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.opus,
  },
  {
    id: 'sonnet',
    label: 'Sonnet 5',
    displayName: 'Claude Sonnet 5',
    resolvedModel: 'claude-sonnet-5',
    note: 'The balanced default: strong on code, much cheaper than Opus.',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsUltracode: true,
    adaptiveThinking: true,
    tier: CLAUDE_FAMILY_TIERS.sonnet,
  },
  {
    id: 'haiku',
    label: 'Haiku 4.5',
    displayName: 'Claude Haiku 4.5',
    resolvedModel: 'claude-haiku-4-5-20251001',
    note: 'Fastest and cheapest. Best for small, mechanical edits.',
    tier: CLAUDE_FAMILY_TIERS.haiku,
  },
];

/** How long {@link fetchClaudeModels} waits for the CLI before giving up. */
const MODEL_FETCH_TIMEOUT_MS = 15_000;

/** What {@link fetchClaudeModels} needs in order to reach the CLI. */
export interface ClaudeModelQuery {
  /** Profile environment. Decides which account the CLI answers as. */
  readonly env: EnvBundle;
  /** An absolute directory to run in. The CLI resolves config relative to it. */
  readonly cwd: string;
  /** See {@link ResolvedRunInput.inheritHostEnv}. */
  readonly inheritHostEnv?: boolean;
  /** See {@link ClaudeAdapterOptions.hostEnv}. */
  readonly hostEnv?: EnvBundle;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
  /** Override the default timeout. Mostly for tests. */
  readonly timeoutMs?: number;
}

/**
 * Ask the installed CLI what models it actually offers.
 *
 * This is the authoritative catalogue and {@link CLAUDE_MODELS} is the
 * fallback, not the other way round. The reasoning is the same one that made
 * the picker use aliases instead of dated snapshots, taken one step further: a
 * hard-coded list is wrong the day a model ships, and no amount of diligence
 * fixes that from inside this file. The CLI already knows the answer, including
 * the things Artemis cannot infer — the provider's own display names, which
 * effort levels each model really accepts, and which support fast mode.
 *
 * ## Why this opens a query it never prompts
 *
 * `supportedModels()` is a *control request*, and the SDK only serves control
 * requests over a streaming session — there is no one-shot "describe yourself"
 * call, and `startup()`'s `WarmQuery` exposes only `query()` and `close()`.
 * So the cheapest legal path is to open a query whose prompt stream never
 * yields, ask on the control channel, and tear it down. No turn is ever
 * started, nothing is billed, and the subprocess lives for the length of one
 * round-trip.
 *
 * ## It resolves rather than throws
 *
 * Every failure path returns {@link CLAUDE_MODELS} instead of rejecting. This
 * runs on the boot path of a desktop app whose model picker must render
 * *something*: a machine with no CLI installed, no credential, or no network is
 * a machine where the user still needs to see a list and change a setting. The
 * diagnostic sink is told what went wrong; the UI is handed a usable list.
 */
export async function fetchClaudeModels(
  request: ClaudeModelQuery,
  onDiagnostic?: (message: string, detail?: unknown) => void,
): Promise<ModelCatalogue> {
  const abort = new AbortController();

  /*
   * A prompt stream that yields nothing and never returns. Returning instead
   * would close the input channel and let the CLI decide the session is over
   * before the control request lands; this parks until `abort` tears it down.
   */
  const idlePrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();

  let sdkQuery: Query | undefined;
  try {
    const env = composeProviderEnv(request.env, {
      inheritHostEnv: request.inheritHostEnv,
      hostEnv: request.hostEnv,
      scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
    });
    env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

    sdkQuery = query({
      prompt: idlePrompt,
      options: {
        ...(request.sdkExecutablePath === undefined
          ? {}
          : { pathToClaudeCodeExecutable: request.sdkExecutablePath }),
        cwd: request.cwd,
        env,
        abortController: abort,
        // Same isolation rule as a run: no filesystem settings are inherited.
        settingSources: [],
        // Nothing is going to be displayed, so do not pay for token streaming.
        includePartialMessages: false,
      },
    });

    const infos = await withTimeout(
      sdkQuery.supportedModels(),
      request.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS,
    );

    /*
     * The CLI's own list includes a "Default (recommended)" row — an alias that
     * points at whichever model it currently prefers rather than naming one.
     * It is dropped here for the same reason Artemis's picker no longer offers a
     * "provider default": a row that names no model cannot tell the user what
     * the next run will cost or how capable it will be, and it sits at the top
     * of the list collecting the clicks of people who have not decided yet.
     * Every row Artemis shows is a real, named model.
     */
    const mapped = infos
      .map(toModelOption)
      .filter((m) => m.id.length > 0 && !isDefaultAlias(m));
    if (mapped.length === 0) {
      onDiagnostic?.('The Claude CLI reported an empty model list; using the built-in list.');
      return { models: CLAUDE_MODELS, live: false };
    }
    return { models: mapped, live: true };
  } catch (error) {
    onDiagnostic?.(`Could not read the model list from the Claude CLI: ${describe(error)}`, error);
    return { models: CLAUDE_MODELS, live: false };
  } finally {
    abort.abort();
    // `interrupt`/`return` on a query that never ran a turn can itself throw;
    // this is best-effort cleanup and must not mask the result above.
    try {
      await sdkQuery?.return?.(undefined);
    } catch {
      /* the abort above is what actually reclaims the subprocess */
    }
  }
}

/**
 * Translate one SDK `ModelInfo` into the descriptor the UI builds pickers from.
 *
 * Two derivations are worth naming:
 *
 *  - **`label` strips the "Claude " prefix.** Every row would otherwise start
 *    with the same eight characters, in a status-line segment that truncates at
 *    fifteen. The full name survives on `displayName`, which is what the
 *    settings catalogue shows.
 *  - **`supportsUltracode` is derived from `xhigh`,** because that is the
 *    provider's own stated precondition ("requires an xhigh-capable model")
 *    rather than a guess. There is no dedicated flag on `ModelInfo` to read.
 */
/**
 * A short, versioned name for the picker: "Opus 5", "Sonnet 5", "Haiku 4.5".
 *
 * Derived from the wire id rather than from `displayName`, because the CLI's
 * display names are written for its own picker and are not what this one needs.
 * In practice it reports "Opus (1M context)", "Sonnet", "Haiku" — a parenthetical
 * about a context window that is now standard on every current model, and no
 * version numbers at all, so two Sonnet generations would be indistinguishable.
 * The wire id always carries the version: `claude-opus-5`, `claude-haiku-4-5`.
 *
 * Falls back to the display name when a provider publishes no resolution, since
 * a name from the provider beats one this function invented.
 */
export function shortModelName(info: ModelInfo): string {
  const wire = info.resolvedModel;
  if (wire !== undefined) {
    const parts = wire
      .replace(/^claude-/i, '')
      // Dated snapshot suffix — `claude-haiku-4-5-20251001`. It is not part of
      // the version a human says out loud.
      .replace(/-\d{8}$/, '')
      // Variant suffix — `claude-opus-5[1m]`. It marks the 1M-context variant,
      // which is the only context every current model has, so it distinguishes
      // nothing and reads as noise on a row this narrow.
      .replace(/\[[^\]]*\]$/, '')
      .split('-');
    const [family, ...version] = parts;
    if (family !== undefined && family.length > 0) {
      const named = family.charAt(0).toUpperCase() + family.slice(1);
      return version.length > 0 ? `${named} ${version.join('.')}` : named;
    }
  }
  return info.displayName.replace(/^Claude\s+/i, '').trim() || info.value;
}

/**
 * Is this row a pointer at "whatever the CLI prefers" rather than a model?
 *
 * Matched on the alias rather than the display text, because the text is the
 * CLI's to reword and `default` is the id it has to keep — anything sending
 * `model: "default"` depends on it. The display check is a second net for a
 * provider that names the concept differently without using that alias.
 */
export function isDefaultAlias(model: ProviderModelOption): boolean {
  return model.id === 'default' || /^default\b/i.test(model.displayName ?? '');
}

function toModelOption(info: ModelInfo): ProviderModelOption {
  const levels = info.supportedEffortLevels;
  return {
    id: info.value,
    label: shortModelName(info),
    displayName: info.displayName,
    resolvedModel: info.resolvedModel,
    note: info.description,
    // The resolution first: `value` may be an alias the CLI invented, while
    // `resolvedModel` always names a real model and therefore a real family.
    tier: claudeModelTier(info.resolvedModel ?? info.value),
    // `supportsEffort: false` means "takes no effort setting", which is an
    // empty array here — distinct from `undefined`, which means "every level".
    effortLevels: info.supportsEffort === false ? [] : levels ? [...levels] : undefined,
    supportsFastMode: info.supportsFastMode ?? false,
    supportsUltracode: levels?.includes('xhigh') ?? false,
    adaptiveThinking: info.supportsAdaptiveThinking ?? false,
  };
}

/**
 * Reasoning-effort levels, least to most.
 *
 * Mirrors the SDK's `EffortLevel` union, which is the authoritative list —
 * these ids go straight onto `Options.effort`.
 *
 * **No per-model `effortLevels` are declared**, and that is a decision rather
 * than an omission. Not every model accepts every level, but the provider
 * resolves that itself: the SDK documents that the active level is the one
 * chosen "after any silent downgrade for the selected model". So a level this
 * model cannot do degrades rather than failing, and inventing a per-model table
 * here would mean maintaining a second, less accurate copy of a fact the
 * provider already knows. `ProviderModelOption.effortLevels` exists for a
 * provider that rejects instead of downgrading.
 */
export const CLAUDE_EFFORT_LEVELS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Minimal thinking. Fastest, cheapest, least reliable.' },
  { id: 'medium', label: 'Medium', note: 'Moderate thinking for routine work.' },
  { id: 'high', label: 'High', note: 'Deep reasoning. The provider’s own default.' },
  { id: 'xhigh', label: 'Extra high', note: 'More thinking again, on models that offer it.' },
  { id: 'max', label: 'Max', note: 'Maximum effort. Select models only; others downgrade.' },
];

const CLAUDE_EFFORT_IDS: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS.map((e) => e.id));

/** `platform-arch` pairs the SDK ships a runtime binary for. */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

/** How long `dispose()` waits for a graceful shutdown before forcing an abort. */
const DISPOSE_GRACE_MS = 4_000;

/** How long `interrupt()` waits for the control channel before forcing an abort. */
const INTERRUPT_TIMEOUT_MS = 8_000;

/** Lines of provider stderr kept for diagnosing a failed run. */
const STDERR_TAIL_LINES = 20;

/**
 * How long a naming call gets before it is abandoned.
 *
 * Generous for what it is — the smallest model answering six words takes a
 * second or two — because the cost of waiting is nothing (it runs beside a real
 * run, and nothing is blocked on it) while the cost of a premature give-up is a
 * session that stays unnamed. It exists so a wedged subprocess cannot sit there
 * forever, not to keep the feature snappy.
 */
const TITLE_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createClaudeAdapter}. */
export interface ClaudeAdapterOptions {
  /** Injectable clock, used for every `ts` and every duration. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The environment to inherit from. Defaults to `process.env`. Injectable so a
   * test can prove the scrub list works without touching the real environment.
   */
  readonly hostEnv?: EnvBundle;
  /**
   * Sink for things worth knowing but not worth surfacing to the user: a
   * message the mapper choked on, a permission update that could not be
   * forwarded. Never called with a secret — everything is scrubbed first.
   */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;
  /**
   * Real-filesystem path to the SDK's bundled CLI binary, when the host knows
   * the SDK's own resolution would be wrong.
   *
   * The one host that knows is Electron: modules packed into `app.asar` see
   * virtual `__dirname`s, and `child_process.spawn` is deliberately not
   * patched to translate them — so the SDK computing a sibling-package path
   * for its binary produces `spawn ENOTDIR` against the archive file. The
   * composition root that lives in Electron resolves the `app.asar.unpacked`
   * path and injects it here; every other host leaves this unset and the SDK
   * resolves itself.
   */
  readonly sdkExecutablePath?: string;
}

/**
 * Create the Claude adapter.
 *
 * The adapter is a stateless singleton: one instance serves every run, and all
 * per-run state lives on the {@link Run} objects it returns.
 */
export function createClaudeAdapter(options?: ClaudeAdapterOptions): ProviderAdapter {
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv;
  const diagnostic = options?.onDiagnostic;
  // Spread at every `query()` call: absent entirely unless the host injected
  // a path, so the SDK's own resolution stays untouched everywhere else.
  const sdkExecutable =
    options?.sdkExecutablePath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.sdkExecutablePath };

  return {
    id: CLAUDE_PROVIDER_ID,
    label: 'Claude',
    capabilities: CLAUDE_CAPABILITIES,
    credentials: CLAUDE_CREDENTIALS,
    models: CLAUDE_MODELS,
    effortLevels: CLAUDE_EFFORT_LEVELS,

    /*
     * The live counterpart to `models` above. Present because Claude *can*
     * enumerate itself; see `fetchClaudeModels` for why it opens a query it
     * never prompts, and `ProviderAdapter.listModels` for the two obligations
     * it is meeting (no model tokens, and resolve rather than reject).
     *
     * The adapter's own diagnostic sink is passed through, so a machine that
     * cannot reach the CLI leaves a trace explaining why the picker is showing
     * the built-in list — without that, a silent fallback is indistinguishable
     * from a working fetch that happens to agree with it.
     */
    async listModels(query: ModelListQuery): Promise<ModelCatalogue> {
      return fetchClaudeModels(
        {
          env: query.env,
          cwd: query.cwd,
          inheritHostEnv: query.inheritHostEnv,
          hostEnv,
          ...(options?.sdkExecutablePath === undefined
            ? {}
            : { sdkExecutablePath: options.sdkExecutablePath }),
        },
        diagnostic,
      );
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      validateRunInput(input);

      /*
       * The staging directory is created for *every* run, attachments or not.
       *
       * It has to exist before `start()`, because the only way to tell the SDK
       * a directory is readable is `Options.additionalDirectories`, and options
       * are built once when the query opens. A directory created later — when
       * the user attaches a file to a mid-run steer — would be one the agent is
       * not allowed to open, and the failure would be the agent reporting that
       * a file the user can see in the transcript does not exist.
       *
       * So it is created up front and granted up front. An empty temp directory
       * that Artemis owns widens nothing, and one `mkdtemp` is not a cost worth
       * making a mid-run attachment fail over.
       */
      const directory = await createStagingDirectory();

      try {
        const staged = await stageAttachments(
          directory,
          (input.attachments ?? []).filter(isFileAttachment),
        );

        const granted: ResolvedRunInput = {
          ...input,
          additionalDirectories: [...(input.additionalDirectories ?? []), directory],
        };

        const run = new ClaudeRun(
          granted,
          {
            now,
            hostEnv,
            diagnostic,
            ...(options?.sdkExecutablePath === undefined
              ? {}
              : { sdkExecutablePath: options.sdkExecutablePath }),
          },
          { directory, staged },
        );
        run.start();
        return run;
      } catch (error) {
        // Nothing owns the directory yet — the run that would have removed it
        // was never constructed.
        await removeStagingDirectory(directory);
        throw error;
      }
    },

    async listSessions(request: SessionListQuery): Promise<SessionListPage> {
      const offset = request.offset ?? 0;
      const limit = request.limit;
      const configDir = readEnv(request.env, CLAUDE_CONFIG_DIR_ENV);

      let infos;
      try {
        infos = await withClaudeConfigDir(configDir, () =>
          sdkListSessions({
            dir: request.cwd,
            // Over-fetch by one so `hasMore` is a fact rather than a guess: the
            // SDK returns a bare array with no total.
            limit: limit === undefined ? undefined : limit + 1,
            offset,
          }),
        );
      } catch (error) {
        throw adapterError('unknown', `Could not read Claude session history: ${describe(error)}`, {
          cause: error,
        });
      }

      const hasMore = limit !== undefined && infos.length > limit;
      const page = limit === undefined ? infos : infos.slice(0, limit);

      return {
        sessions: page.map((info) =>
          mapSessionInfo(info, { profileId: request.profileId, fallbackCwd: request.cwd }),
        ),
        hasMore,
      };
    },

    /**
     * Every session in every project, for every profile asked about.
     *
     * ## How this is only one SDK call per profile
     *
     * `listSessions({ dir })` scopes to one project. Omitting `dir` makes the
     * SDK walk `$CLAUDE_CONFIG_DIR/projects/*` itself and return everything —
     * which is exactly the enumeration this needs, and it reads each session's
     * `cwd` out of the transcript rather than from the directory name. That
     * matters: the directory name is a lossy encoding of the path (every
     * non-alphanumeric character becomes `-`), so reconstructing a cwd from it
     * would be a guess. Since every Artemis profile has its own
     * `CLAUDE_CONFIG_DIR`, one such call per profile covers the whole
     * (profile × project) space, and a session's profile falls out of *which*
     * config directory it was found in — no extra bookkeeping anywhere.
     *
     * ## Read-only, and credential-free
     *
     * Only `CLAUDE_CONFIG_DIR` is read out of each scope's env. Callers build
     * those with `resolveStoreEnv`, which emits that one variable and no
     * secret, so a profile that has never had a key stored still lists its
     * history.
     *
     * ## One bad profile cannot blank the sidebar
     *
     * Each profile is read inside its own `try`. A missing, unreadable or empty
     * config directory contributes nothing and is reported in
     * `unreadableProfiles`; the rest of the profiles still answer.
     */
    async listAllSessions(request: AllSessionsQuery): Promise<AggregatedSessionList> {
      const sessions: SessionSummary[] = [];
      const unreadableProfiles: ProfileId[] = [];
      let droppedWithoutCwd = 0;

      for (const scope of request.profiles) {
        const configDir = readEnv(scope.env, CLAUDE_CONFIG_DIR_ENV);

        let infos;
        try {
          // No `dir`, no `limit`, no `offset`: everything this profile has.
          // Pagination belongs to whoever merges across profiles — slicing here
          // would drop one profile's older sessions in favour of another's
          // newer ones before they were ever compared.
          infos = await withClaudeConfigDir(configDir, () => sdkListSessions({}));
        } catch (error) {
          unreadableProfiles.push(scope.profileId);
          diagnostic?.(
            `Could not read session history for profile ${scope.profileId}.`,
            describe(error),
          );
          continue;
        }

        for (const info of infos) {
          const summary = mapAggregatedSessionInfo(info, { profileId: scope.profileId });
          if (summary === null) {
            droppedWithoutCwd += 1;
            continue;
          }
          sessions.push(summary);
        }
      }

      if (droppedWithoutCwd > 0) {
        diagnostic?.(
          `Skipped ${String(droppedWithoutCwd)} session(s) whose working directory could not be read from the transcript.`,
        );
      }

      sessions.sort(byNewestThenId);
      return { sessions, unreadableProfiles };
    },

    async checkAvailability(): Promise<AdapterAvailability> {
      const key = `${process.platform}-${process.arch}`;
      if (!SUPPORTED_PLATFORMS.has(key)) {
        return {
          available: false,
          unavailableReason: `Claude does not ship a runtime for ${key}.`,
        };
      }
      return { available: true };
    },

    /**
     * Count without mapping.
     *
     * The same read `getSessionMessages` does — the SDK gives no cheaper way to
     * ask "how many?" — but it stops at `.length` instead of turning every
     * stored record into events, which is where the cost of the read actually
     * is. Runs on the path of starting a resumed run, so what it skips matters:
     * a long conversation is a file read and a JSON parse, not a transcript
     * rebuild.
     *
     * Throws on a failed read rather than answering `0`, because the caller
     * has to be able to tell "this session is empty" from "I could not look".
     * A zero it invented would make a reloading window replay the whole
     * conversation twice.
     */
    async countSessionMessages(input: SessionMessageCountQuery): Promise<number> {
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);
      try {
        const stored = await withClaudeConfigDir(configDir, () =>
          sdkGetSessionMessages(input.sessionId, {
            ...(input.cwd === undefined ? {} : { dir: input.cwd }),
          }),
        );
        return stored.length;
      } catch (error) {
        throw adapterError('unknown', `Could not read that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async getSessionMessages(input: SessionMessagesQuery): Promise<SessionTranscript> {
      /*
        `limit + 1` is how "is there more?" gets answered without a second
        call: the SDK reports no total, so the only way to know a page is not
        the last one is to ask for one row past it and throw that row away.
      */
      const limit = input.limit;

      /*
        The SDK reads `CLAUDE_CONFIG_DIR` from `process.env` — it takes no env
        option — so the profile's store is selected by swapping that variable
        around the call, exactly as `listSessions` does. `withClaudeConfigDir`
        serialises those swaps; without it two profiles read each other's
        history.
      */
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      let stored;
      try {
        stored = await withClaudeConfigDir(configDir, () =>
          sdkGetSessionMessages(input.sessionId, {
            ...(input.cwd === undefined ? {} : { dir: input.cwd }),
            ...(limit === undefined ? {} : { limit: limit + 1 }),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
          }),
        );
      } catch (error) {
        throw adapterError('unknown', `Could not read that session: ${describe(error)}`, {
          cause: error,
        });
      }

      const hasMore = limit !== undefined && stored.length > limit;
      const page = hasMore ? stored.slice(0, limit) : stored;

      let seq = 0;
      const events = replayStoredSession(page as unknown as readonly StoredMessage[], {
        runId: input.runId,
        sessionId: input.sessionId,
        ts: now(),
        next: () => seq++,
      });

      return { events, hasMore };
    },

    /**
     * Name a conversation from its opening message.
     *
     * A one-shot completion with everything a run has switched off, and each
     * switch is load-bearing rather than tidy:
     *
     *  - **`persistSession: false`** — without it this call writes a session
     *      file of its own, and a feature whose entire job is to label the
     *      history pane would put a junk row in it on every new conversation.
     *      This is the option the whole approach depends on.
     *  - **`tools: []`** — the restriction knob (see `buildOptions` for why it
     *      is `tools` and not `allowedTools`). A naming call that could reach
     *      Bash is a naming call that can be talked into using it by the very
     *      text it was asked to summarise.
     *  - **`maxTurns: 1`** — one answer, no agentic loop. With no tools there
     *      is nothing to loop over, so this is the second lock on the same door.
     *  - **`settingSources: []`** — the same isolation every other path here
     *      gets: no hooks, no MCP servers, no `CLAUDE.md` pulled in to pad a
     *      six-word answer.
     *  - **A replacing `systemPrompt`** — a bare string, which is the *only*
     *      form that displaces the coding-agent preset (see `mapSystemPrompt`).
     *      Keeping the preset would spend far more tokens describing tools this
     *      call cannot use than it spends on the title.
     *
     * Resolves `null` on every failure, per the seam's contract. A machine with
     * no CLI, an account that cannot use the model it was handed, or a model
     * that answered with a paragraph all mean the same thing to the caller:
     * this session keeps the name it would otherwise have had.
     */
    async suggestSessionTitle(request: SessionTitleQuery): Promise<string | null> {
      // Aborting the controller is what actually reclaims the subprocess, so
      // the caller's signal is bridged onto it rather than checked in a loop.
      const abort = new AbortController();
      const forwardAbort = (): void => {
        abort.abort();
      };
      if (request.abortSignal?.aborted === true) return null;
      request.abortSignal?.addEventListener('abort', forwardAbort, { once: true });

      let sdkQuery: Query | undefined;
      try {
        const env = composeProviderEnv(request.env, {
          inheritHostEnv: request.inheritHostEnv,
          hostEnv,
          scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
        });
        env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

        sdkQuery = query({
          prompt: buildTitlePrompt(request.prompt),
          options: {
        ...sdkExecutable,
            cwd: request.cwd,
            env,
            model: request.model,
            abortController: abort,
            settingSources: [],
            persistSession: false,
            includePartialMessages: false,
            maxTurns: 1,
            tools: [],
            systemPrompt: SESSION_TITLE_INSTRUCTIONS,
          },
        });

        const answer = await withTimeout(readTitleAnswer(sdkQuery), TITLE_TIMEOUT_MS);
        if (!answer.ok) {
          diagnostic?.(`Could not name the session: ${answer.reason}`);
          return null;
        }

        const title = cleanSessionTitle(answer.text);
        if (title === null && !isDeclinedTitle(answer.text)) {
          // Worth a line: a model that keeps answering with prose is a prompt
          // problem, and this is the only place that would ever show it. A
          // model that *declined* is excluded — that is the prompt working, and
          // logging it made "hey" look like a fault on every new session.
          diagnostic?.(
            `Discarded an unusable session title: ${JSON.stringify(answer.text.slice(0, 120))}`,
          );
        }
        return title;
      } catch (error) {
        diagnostic?.(`Could not name the session: ${describe(error)}`, error);
        return null;
      } finally {
        request.abortSignal?.removeEventListener('abort', forwardAbort);
        abort.abort();
        try {
          await sdkQuery?.return?.(undefined);
        } catch {
          /* the abort above is what actually reclaims the subprocess */
        }
      }
    },

    /**
     * Write a title onto a stored session.
     *
     * `renameSession` appends a custom-title entry to the session's JSONL,
     * which is the same thing the CLI's own `/rename` writes — so the name
     * Artemis generated is read straight back by `listSessions` as
     * `customTitle`, and the user's own `claude` sees it too.
     *
     * The config-directory swap is the same one listing and history use, and
     * for the same reason: the SDK's standalone session functions take no
     * environment and resolve the store from `process.env`. `dir` narrows the
     * search to one project, which matters here more than it does for a read —
     * without it the SDK walks every project directory looking for the id.
     */
    async setSessionTitle(update: SessionTitleUpdate): Promise<void> {
      const configDir = readEnv(update.env, CLAUDE_CONFIG_DIR_ENV);
      try {
        await withClaudeConfigDir(configDir, () =>
          sdkRenameSession(
            update.sessionId,
            update.title,
            update.cwd === undefined ? undefined : { dir: update.cwd },
          ),
        );
      } catch (error) {
        throw adapterError('unknown', `Could not rename the Claude session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    /**
     * Delete a session's transcript from disk, along with its subagent
     * transcripts. There is no undo.
     *
     * The counterpart to {@link setSessionTitle} rather than a sibling of it:
     * both are writes to the same store, reached by the same config-directory
     * swap and narrowed by the same `dir`.
     *
     * Returns false rather than throwing when the transcript is already gone.
     * The SDK throws for a missing session, and that case is routine here in a
     * way it is not for a read: a second click, or a transcript removed in a
     * terminal since the sidebar last listed it, both arrive as "not found",
     * and the user's intent — that this session stop existing — is already
     * satisfied. Every other failure still throws; only absence is forgiven,
     * which is why this inspects the error rather than swallowing all of them.
     */
    async deleteSession(input: SessionDeleteQuery): Promise<boolean> {
      const configDir = readEnv(input.env, CLAUDE_CONFIG_DIR_ENV);

      try {
        await withClaudeConfigDir(configDir, () =>
          sdkDeleteSession(input.sessionId, {
            ...(input.cwd === undefined ? {} : { dir: input.cwd }),
          }),
        );
        return true;
      } catch (error) {
        if (isMissingSession(error)) return false;
        throw adapterError('unknown', `Could not delete that session: ${describe(error)}`, {
          cause: error,
        });
      }
    },

    async fetchPlanUsage(input: PlanUsageQuery): Promise<PlanUsage> {
      /*
        A control-plane read, deliberately never a turn.

        The prompt is an async iterable that yields nothing and never settles.
        `query()` therefore starts the CLI and opens its control channel, but
        the model is never sampled — so this costs one subprocess spawn and
        zero tokens. Pushing even an empty user message here would bill the
        user for opening a gauge.

        `settingSources: []` for the same reason it is set on runs: a
        distributed app must not silently inherit the user's personal
        configuration, and a usage probe has even less business doing so.
      */
      const idlePrompt = (async function* (): AsyncGenerator<never> {
        await new Promise<never>(() => {});
      })();

      let sdkQuery: ReturnType<typeof query> | undefined;
      try {
        sdkQuery = query({
          prompt: idlePrompt,
          options: {
        ...sdkExecutable,
            cwd: input.cwd,
            /*
              The SAME composition a real run uses, and it has to be.

              Passing `input.env` raw hands the subprocess only the profile's
              own variables — no `HOME`, no `PATH`. Claude resolves its config
              directory and its Keychain credentials through `HOME`, so without
              it the CLI cannot see the subscription at all and reports
              `rate_limits_available: false` — which reads as "this is an API
              account" when it actually means "I could not find your account".
            */
            env: composeProviderEnv(input.env, {
              ...(hostEnv === undefined ? {} : { hostEnv }),
              scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
            }) as Record<string, string>,
            settingSources: [],
          },
        });
        return await readPlanUsage(sdkQuery, now());
      } catch (cause) {
        // Spawning the CLI can fail for all the ordinary reasons — a bad cwd, a
        // missing runtime. None of them justify breaking the caller, which is a
        // status-line widget.
        return {
          available: false,
          unavailableReason: `Could not read plan usage: ${cause instanceof Error ? cause.message : String(cause)}`,
          windows: [],
          fetchedAt: now(),
        };
      } finally {
        // The idle prompt never completes, so without this the subprocess
        // outlives the call. `close()` is the only thing that ends it.
        try {
          sdkQuery?.close();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/**
 * Newest first, then by id.
 *
 * The id tiebreak is not cosmetic: two sessions written in the same
 * millisecond would otherwise order differently between calls, and a history
 * list that reshuffles on refresh looks broken.
 */
function byNewestThenId(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function validateRunInput(input: ResolvedRunInput): void {
  if (!isAbsolute(input.cwd)) {
    throw adapterError('invalid_request', `Working directory must be an absolute path: ${input.cwd}`);
  }

  if (input.permissionMode !== undefined) {
    // Reject rather than downgrade. Silently falling back to a different mode is
    // how a run ends up more permissive than the user asked for.
    if (!CLAUDE_CAPABILITIES.permissionModes.includes(input.permissionMode)) {
      throw adapterError(
        'invalid_request',
        `Claude does not support the permission mode "${input.permissionMode}".`,
      );
    }
  }

  if (input.effort !== undefined && !CLAUDE_EFFORT_IDS.has(input.effort)) {
    // Rejected, not dropped. `model` is deliberately open because the provider
    // accepts ids beyond the ones worth listing, but `effort` is a closed union
    // in the SDK: an unrecognised value would be forwarded and either error deep
    // inside the CLI or be ignored, and a silently ignored effort setting is the
    // kind of failure the user only notices on the invoice.
    throw adapterError(
      'invalid_request',
      `Claude does not support the reasoning effort "${input.effort}". Expected one of: ${CLAUDE_EFFORT_LEVELS.map((e) => e.id).join(', ')}.`,
    );
  }

  if (input.forkSession === true && input.resumeSessionId === undefined) {
    throw adapterError(
      'invalid_request',
      'forkSession requires resumeSessionId — there is nothing to fork from.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Options construction                                                       */
/* -------------------------------------------------------------------------- */

/** Everything {@link buildClaudeOptions} needs beyond the run input. */
export interface BuildClaudeOptionsContext {
  readonly canUseTool: CanUseTool;
  readonly abortController: AbortController;
  readonly stderr: (data: string) => void;
  readonly hostEnv?: EnvBundle;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
}

/**
 * Translate a {@link ResolvedRunInput} into the SDK's `Options`.
 *
 * Exported because this is where a mistake is expensive and invisible: an
 * unmapped `settingSources`, a `forkSession` without `resume`, a permission
 * mode that quietly did not apply. Keeping it a pure function makes each of
 * those assertable.
 */
export function buildClaudeOptions(
  input: ResolvedRunInput,
  context: BuildClaudeOptionsContext,
): Options {
  const env = composeProviderEnv(input.env, {
    inheritHostEnv: input.inheritHostEnv,
    hostEnv: context.hostEnv,
    scrubKeys: CLAUDE_ENV_SCRUB_KEYS,
  });

  // Identify Artemis in the provider's User-Agent, unless the profile already
  // chose an identifier.
  env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'artemis';

  const permissionMode = input.permissionMode;

  return {
    ...(context.sdkExecutablePath === undefined
      ? {}
      : { pathToClaudeCodeExecutable: context.sdkExecutablePath }),
    cwd: input.cwd,
    env,
    abortController: context.abortController,
    canUseTool: context.canUseTool,
    stderr: context.stderr,

    // Isolation. `[]` means "load no filesystem settings" — see the file header.
    settingSources: [...(input.settingSources ?? [])] as SettingSource[],

    includePartialMessages: input.includePartialMessages !== false,

    model: input.model,
    fallbackModel: input.fallbackModel,
    // `validateRunInput` has already rejected anything outside the declared
    // levels, so this cast narrows a checked value rather than asserting an
    // unchecked one.
    effort: input.effort as Options['effort'],
    // Fast mode and ultracode are *settings*, not top-level options, so they
    // ride the flag-settings layer. Absent when neither was asked for: an empty
    // object here is not inert — it is a flag-settings layer that exists, and
    // the layer has the highest priority among user-controlled settings.
    settings: buildFlagSettings(input),
    permissionMode,
    // The SDK gates `bypassPermissions` behind an explicit opt-in. Passing it
    // only when the user picked that mode keeps the dangerous flag tied to a
    // deliberate choice instead of becoming an ambient default.
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,

    resume: input.resumeSessionId,
    // Only meaningful alongside `resume`; `validateRunInput` has already
    // rejected the combination that is not.
    forkSession: input.resumeSessionId !== undefined ? input.forkSession : undefined,

    // `RunInput.allowedTools` is an allow-*list*: it narrows which tools exist.
    // The SDK's `Options.allowedTools` is a different knob with a confusingly
    // similar name — it auto-approves tools without prompting, and leaves the
    // full default tool set in place. Mapping onto it would make a run strictly
    // *more* permissive than asked: Bash/Edit/Write would remain available, and
    // the named tools would additionally bypass `canUseTool` entirely (the SDK
    // warns about that shadowing under `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`).
    // `Options.tools` is the restriction knob, so that is what this maps to.
    tools: input.allowedTools === undefined ? undefined : [...input.allowedTools],
    disallowedTools: input.disallowedTools === undefined ? undefined : [...input.disallowedTools],
    additionalDirectories:
      input.additionalDirectories === undefined ? undefined : [...input.additionalDirectories],

    maxTurns: input.maxTurns,
    maxBudgetUsd: input.maxBudgetUsd,
    systemPrompt: mapSystemPrompt(input.systemPrompt),
    title: input.title,
  };
}

/**
 * Assemble the flag-settings layer from the run's speed/depth knobs.
 *
 * `fastMode` and `ultracode` are not top-level `Options` fields — they live in
 * `Settings`, which `Options.settings` loads into the flag layer (the same one
 * the CLI's `--settings` flag feeds, and the highest-priority user-controlled
 * tier). Both are session-scoped by design: the SDK documents that interactive
 * ultracode toggles never persist, which matches Artemis's model exactly, since
 * every run is configured from the status line rather than from a config file.
 *
 * Returns `undefined` rather than `{}` when neither is set. Passing an empty
 * object would still *establish* a flag-settings layer, and a layer that exists
 * but says nothing is not the same as no layer at all — this keeps a run that
 * asked for neither knob byte-identical to one from before they existed.
 *
 * Nothing here checks whether the selected model supports either flag. That is
 * the UI's job (it has the model descriptor and can disable the control with a
 * reason) and the provider's job (it resolves entitlement, cooldown and model
 * eligibility server-side). Duplicating the check here would mean maintaining a
 * third, staler copy of a fact the other two already own — the same argument
 * that keeps per-model effort tables out of this file.
 */
export function buildFlagSettings(input: ResolvedRunInput): Settings | undefined {
  const settings: Settings = {};
  if (input.fastMode === true) settings.fastMode = true;
  if (input.ultracode === true) settings.ultracode = true;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Map protocol's {@link SystemPromptSpec} onto the SDK's `systemPrompt`.
 *
 * `append` keeps the provider's own preset and adds to it, which is the only
 * safe way to add project conventions: the preset is what describes the tools
 * to the model, so `replace` reliably degrades tool use.
 *
 * ## Absent is not "leave it to the SDK"
 *
 * `RunInput.systemPrompt` is optional, and the obvious reading — omit the
 * option and the CLI uses its own prompt — is wrong. The SDK normalises an
 * omitted `systemPrompt` to the empty *string* (`if (s === undefined) d = ""`)
 * and forwards it on the `initialize` control request as `[""]`, which the CLI
 * treats as an explicit custom prompt and uses **instead of** its preset. Only
 * the object form leaves the field absent and lets the preset through.
 *
 * So the absent case is mapped to `kind: 'default'` rather than to `undefined`.
 * Getting this wrong is invisible and total: every default run would lose the
 * whole Claude Code behavioural prompt — tool guidance, context sections,
 * coding-agent conventions — which is exactly the `replace` degradation this
 * function exists to avoid. The unknown-kind fallback goes the same way, on the
 * same reasoning: a spec this function does not understand must not silently
 * become "no system prompt at all".
 */
export function mapSystemPrompt(spec: SystemPromptSpec | undefined): Options['systemPrompt'] {
  if (spec === undefined) return { type: 'preset', preset: 'claude_code' };
  switch (spec.kind) {
    case 'default':
      return { type: 'preset', preset: 'claude_code' };
    case 'append':
      return { type: 'preset', preset: 'claude_code', append: spec.text };
    case 'replace':
      return spec.text;
    default:
      return { type: 'preset', preset: 'claude_code' };
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

interface PendingPermission {
  readonly deferred: Deferred<PermissionResult>;
  readonly toolName: string;
  readonly toolUseID: string | undefined;
  /**
   * The arguments the call was parked on, and the questions decoded from them.
   *
   * Kept only so an answer can be written back into the tool's own input shape
   * — see {@link ToPermissionResultOptions.question}. Both are undefined for
   * every request that is an ordinary approval, which is nearly all of them.
   */
  readonly input: JsonObject;
  readonly question: QuestionPrompt | undefined;
}

interface ClaudeRunDeps {
  readonly now: () => number;
  readonly hostEnv?: EnvBundle;
  readonly diagnostic?: (message: string, detail?: unknown) => void;
  /** See {@link ClaudeAdapterOptions.sdkExecutablePath}. */
  readonly sdkExecutablePath?: string;
}

class ClaudeRun implements Run {
  readonly runId: string;
  readonly providerId = CLAUDE_PROVIDER_ID;
  readonly capabilities = CLAUDE_CAPABILITIES;

  readonly #input: ResolvedRunInput;
  readonly #deps: ClaudeRunDeps;
  readonly #state: ClaudeMapperState;
  readonly #eventQueue: AsyncQueue<AgentEvent>;
  readonly #promptQueue: AsyncQueue<SDKUserMessage>;
  readonly #pending = new Map<PermissionRequestId, PendingPermission>();
  readonly #abort = new AbortController();
  readonly #stderrTail: string[] = [];

  #query: Query | undefined;
  #pumpDone: Promise<void> = Promise.resolve();
  #disposing: Promise<void> | undefined;
  #permissionCounter = 0;
  #detachAbortSignal: (() => void) | undefined;

  /** Where this run's files live, and how many it has written. */
  readonly #stagingDir: string;
  #stagedCount: number;
  /** The opening prompt's files, held until `start()` builds its message. */
  #openingStaged: readonly StagedAttachment[];

  constructor(
    input: ResolvedRunInput,
    deps: ClaudeRunDeps,
    staging: { readonly directory: string; readonly staged: readonly StagedAttachment[] },
  ) {
    this.#input = input;
    this.#deps = deps;
    this.runId = input.runId;
    this.#stagingDir = staging.directory;
    this.#openingStaged = staging.staged;
    this.#stagedCount = staging.staged.length;

    this.#state = createClaudeMapperState(input.runId, {
      now: deps.now,
      resumedFrom: input.resumeSessionId,
      forked: input.forkSession === true,
    });

    // Abandoning the event stream does not tear the run down — dispose() is the
    // explicit way to do that — but it does mean nobody is listening, which is
    // worth recording.
    this.#eventQueue = new AsyncQueue<AgentEvent>({
      onAbandoned: () => {
        this.#deps.diagnostic?.(`Run ${this.runId}: event stream abandoned by its consumer.`);
      },
    });
    this.#promptQueue = new AsyncQueue<SDKUserMessage>();
  }

  /* ------------------------------ lifecycle ------------------------------- */

  /**
   * Kick the SDK off.
   *
   * Separate from the constructor so the run object exists — and therefore
   * `canUseTool` can reach it — before the first message is consumed.
   */
  start(): void {
    // Seed the input pump before the SDK starts pulling, so the first turn has
    // its prompt waiting rather than racing for it.
    this.#promptQueue.push(
      this.#userMessage(this.#input.prompt, this.#input.attachments, this.#openingStaged),
    );
    // Released once consumed: the payloads are large, and the run has no reason
    // to keep the opening turn's attachments alive for its whole lifetime.
    this.#openingStaged = [];

    const external = this.#input.abortSignal;
    if (external !== undefined) {
      if (external.aborted) {
        void this.dispose();
        return;
      }
      const onAbort = (): void => {
        void this.dispose();
      };
      external.addEventListener('abort', onAbort, { once: true });
      this.#detachAbortSignal = () => {
        external.removeEventListener('abort', onAbort);
      };
    }

    let sdkQuery: Query;
    try {
      sdkQuery = query({
        prompt: this.#promptQueue,
        options: buildClaudeOptions(this.#input, {
          canUseTool: this.#canUseTool,
          abortController: this.#abort,
          stderr: (data) => this.#captureStderr(data),
          hostEnv: this.#deps.hostEnv,
          ...(this.#deps.sdkExecutablePath === undefined
            ? {}
            : { sdkExecutablePath: this.#deps.sdkExecutablePath }),
        }),
      });
    } catch (error) {
      // `query()` itself failed — usually a missing runtime, sometimes a bad
      // cwd wearing a missing runtime's clothes. The run still has to produce a
      // terminal event; a rejected promise from `createRun` would leave a
      // caller that already subscribed with a stream that never ends.
      //
      // Not awaited: `start()` is synchronous by design so the run object is
      // fully constructed before `createRun` returns. The event queue buffers,
      // so a terminal event one tick later is indistinguishable to a consumer
      // iterating `events`.
      void this.#failToLaunch(error);
      return;
    }

    this.#query = sdkQuery;
    this.#pumpDone = this.#pump(sdkQuery);
  }

  get status(): RunStatus {
    if (this.#state.ended) return 'ended';
    if (this.#pending.size > 0) return 'awaiting_permission';
    if (this.#state.sessionStarted) return 'running';
    return 'starting';
  }

  get sessionId(): SessionId | undefined {
    return this.#state.sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.#eventQueue;
  }

  /* -------------------------------- control -------------------------------- */

  /**
   * Push more text at the running turn.
   *
   * ## Why this reports `deliveredImmediately: false`
   *
   * The text does reach the CLI immediately — it is written to the subprocess
   * the moment it is pushed. What the adapter cannot know is whether it *takes
   * effect* in the turn that is running. The CLI only folds a mid-turn message
   * in at a tool-batch boundary; a turn that is composing its final, tool-free
   * response has no boundary left, so the message instead becomes a separate
   * queued turn. A run here is one turn cycle, so that queued turn is never
   * executed: the first `result` ends the run and `close()` takes the transport
   * down with it.
   *
   * Of the three honest answers the seam allows — steer, queue and report
   * `false`, or reject — only "queue and report `false`" is true in both cases.
   * Returning `true` would be a guarantee this layer has no way to make, and
   * the failure it hides is the silent one the seam's contract exists to
   * prevent: a steering message the UI renders as sent that the provider never
   * acted on.
   *
   * `midRunSteering` stays `true` because the fold genuinely works and is the
   * common case; this is about not overstating it.
   */
  async send(text: string, attachments?: readonly Attachment[]): Promise<SendResult> {
    if (this.#state.ended) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} has already ended; start a new run with resumeSessionId to continue.`,
      );
    }

    // Teardown closes the prompt queue at step 2 but only marks the run ended
    // at step 6, with up to two 4s grace waits in between — and `push` on a
    // closed queue is a documented no-op. Without this guard a send landing in
    // that window is discarded and still reports success.
    if (this.#disposing !== undefined || this.#promptQueue.closed) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} is shutting down and cannot accept more input.`,
      );
    }

    // Staged before the push and outside any queue guard, so a staging failure
    // surfaces as itself rather than as a message that silently lost its files.
    const staged = await this.#stage(attachments);

    this.#promptQueue.push(this.#userMessage(text, attachments, staged));
    return { deliveredImmediately: false };
  }

  async interrupt(): Promise<InterruptResult> {
    // "Stop" is idempotent by nature; a run that already stopped is not an error.
    if (this.#state.ended) return { stillQueued: [] };

    this.#state.interruptRequested = true;

    const sdkQuery = this.#query;
    if (sdkQuery === undefined) {
      await this.dispose();
      return { stillQueued: [] };
    }

    try {
      const response = await withTimeout(sdkQuery.interrupt(), INTERRUPT_TIMEOUT_MS);
      return { stillQueued: response?.still_queued ?? [] };
    } catch (error) {
      // The control channel did not answer. Do not leave the user holding a
      // Stop button that did nothing: force the transport down and let the pump
      // emit `run.end` with reason 'interrupted'.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: interrupt did not complete, forcing teardown.`,
        describe(error),
      );
      this.#abort.abort();
      return { stillQueued: [] };
    }
  }

  async respondToPermission(
    requestId: PermissionRequestId,
    decision: PermissionDecision,
  ): Promise<void> {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) {
      // Answering an unknown or already-answered id almost always means the UI
      // has lost track of which prompt it is showing. Failing loudly beats
      // pretending it landed.
      throw adapterError(
        'invalid_request',
        `No outstanding permission request "${requestId}" on run ${this.runId}.`,
      );
    }
    this.#pending.delete(requestId);

    if (decision.behavior === 'deny' && decision.interrupt === true) {
      this.#state.permissionDenyInterrupted = true;
    }

    const { result, droppedUpdates } = toPermissionResult(decision, {
      toolUseID: entry.toolUseID,
      toolName: entry.toolName,
      question: entry.question,
      input: entry.input,
    });

    if (droppedUpdates.length > 0) {
      // The SDK's deny branch has no `updatedPermissions` field, so a "never
      // allow this" rule attached to a denial cannot be forwarded.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: ${String(droppedUpdates.length)} permission update(s) could not be persisted with a denial.`,
      );
    }

    entry.deferred.resolve(result);
    this.#emitResolved(
      requestId,
      decision.behavior === 'allow' ? 'allowed' : 'denied',
      decision.behavior === 'deny' ? decision.message : undefined,
      decision.behavior === 'allow' ? decision.answers : undefined,
    );
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#teardown();
    return this.#disposing;
  }

  /* -------------------------------- internals ------------------------------ */

  async #teardown(): Promise<void> {
    this.#state.disposeRequested = true;
    this.#detachAbortSignal?.();

    // 1. Unblock the provider first. `canUseTool` is parked on a promise; if
    //    nobody settles it, the SDK never returns and neither does close().
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);

    // 2. End the input stream so the SDK's prompt iterable completes.
    this.#promptQueue.close();

    // 3. Ask the SDK to shut its transport down. `close()` is synchronous and
    //    returns void — there is no `dispose()` on Query.
    try {
      this.#query?.close();
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting.
    }

    // 4. Give the pump a chance to emit `run.end` from the SDK's own result.
    await settleWithin(this.#pumpDone, DISPOSE_GRACE_MS);

    // 5. Still alive? Abort hard.
    if (!this.#state.ended) {
      this.#abort.abort();
      await settleWithin(this.#pumpDone, DISPOSE_GRACE_MS);
    }

    // 6. Drop the staged attachments, now that the process that could read them
    //    is gone. After the process, so a turn still winding down cannot lose a
    //    file out from under itself.
    //
    //    Safe to delete: the model has already been sent whatever it was going
    //    to be sent, and a resumed session replays the provider's own stored
    //    transcript — which holds the text of the turn, including the paths. A
    //    resumed run that tries to re-open one gets a plain "no such file",
    //    which is the honest answer: the file was the user's, and it was
    //    attached to a conversation that has since ended.
    await removeStagingDirectory(this.#stagingDir, (message) => {
      this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
    });

    // 7. Guarantee the contract even if the SDK never came back at all: exactly
    //    one `run.end`, and a stream that terminates.
    this.#finalize('disposed');
    this.#eventQueue.close();
    this.#denyAllPending(DISPOSED_DENY_MESSAGE);
  }

  async #pump(sdkQuery: Query): Promise<void> {
    try {
      for await (const message of sdkQuery) {
        let events: readonly AgentEvent[] = [];
        try {
          events = mapSdkMessage(message, this.#state);
        } catch (error) {
          // A mapping bug must degrade to a missing event, never to a dead
          // transcript. The run keeps going.
          this.#deps.diagnostic?.(
            `Run ${this.runId}: failed to map a provider message.`,
            describe(error),
          );
        }

        for (const event of events) this.#emit(event);
        if (this.#state.ended) break;
      }

      if (!this.#state.ended) {
        // The stream ended without a `result` message — the transport closed
        // cleanly but early.
        this.#finalize(this.#exitReason('completed'));
      }
    } catch (error) {
      if (!this.#state.ended) {
        const agentError = toAgentError(error, 'transport');
        if (agentError.code === 'cancelled') {
          this.#finalize(this.#exitReason('interrupted'));
        } else {
          this.#finalize('error', this.#withStderr(await this.#explainLaunchFailure(agentError)));
        }
      }
    } finally {
      try {
        sdkQuery.close();
      } catch {
        // Already closed.
      }
      this.#denyAllPending(DISPOSED_DENY_MESSAGE);
      this.#promptQueue.close();
      this.#eventQueue.close();
      this.#detachAbortSignal?.();
    }
  }

  /**
   * End a run that never started, with a message that names the real cause.
   *
   * Split out of `start()` because the diagnosis is asynchronous — it stats the
   * working directory — and `start()` must not be.
   */
  async #failToLaunch(error: unknown): Promise<void> {
    const explained = await this.#explainLaunchFailure(toAgentError(error, 'provider_not_found'));
    this.#finalize('error', this.#withStderr(explained));
    this.#eventQueue.close();
  }

  /**
   * Re-attribute a launch failure that is really a bad working directory.
   *
   * ## The bug this exists for
   *
   * `spawn` raises `ENOENT` for a missing *executable* **and** for a missing
   * *cwd*, and the two are indistinguishable from the errno. The Agent SDK
   * guesses the first, and guesses confidently: point a run at a directory that
   * does not exist and it reports that the native binary "exists but failed to
   * launch", most likely because it "does not match this system's libc" — a
   * glibc-versus-musl theory, on macOS, about a folder that is not there. A
   * user reading that has no path to the actual fix.
   *
   * So on any failure that looks like a launch failure, the directory is
   * checked. If it is genuinely unusable, that becomes the headline and the
   * provider's own words are kept underneath: the underlying error is
   * **wrapped, never swallowed**, because if the diagnosis is ever wrong the
   * original message is the only way anyone will find out. If the directory is
   * fine, the cwd is still appended — the next time this happens, the message
   * names the directory instead of leaving it to be guessed at.
   */
  async #explainLaunchFailure(error: AgentError): Promise<AgentError> {
    if (!looksLikeLaunchFailure(error)) return error;

    let check;
    try {
      check = await checkWorkingDirectory(this.#input.cwd);
    } catch {
      // The diagnosis is a courtesy. Never let it replace the real failure.
      return error;
    }

    if (check.ok) {
      return {
        ...error,
        message: `${error.message} (working directory: ${this.#input.cwd})`,
      };
    }

    return {
      ...error,
      code: 'invalid_request',
      retryable: false,
      message:
        `${check.message} Claude could not be started because its working directory cannot be used. ` +
        `The provider reported: ${error.message}`,
    };
  }

  /** Artemis's own intent outranks whatever the transport reports. */
  #exitReason(fallback: RunEndReason): RunEndReason {
    if (this.#state.disposeRequested) return 'disposed';
    if (this.#state.interruptRequested) return 'interrupted';
    if (this.#state.permissionDenyInterrupted) return 'permission_denied';
    return fallback;
  }

  #finalize(reason: RunEndReason, error?: AgentError): void {
    for (const event of finalizeRun(this.#state, reason, { error })) this.#emit(event);
  }

  #emit(event: AgentEvent): void {
    if (this.#eventQueue.closed) return;
    this.#eventQueue.push(event);
    // Nothing follows `run.end`: the stream terminates with it, which is what
    // lets a consumer's `for await` finish on its own.
    if (event.type === 'run.end') this.#eventQueue.close();
  }

  /**
   * One user turn, as the SDK's streaming input wants it.
   *
   * Three things can end up in it, and they arrive by three different routes:
   *
   *  - **Images** become `image` blocks. There is no other way for the model to
   *    see a picture — no tool it has can look at one.
   *  - **PDFs** become `document` blocks *as well as* staged files. The block is
   *    what gives the model vision over the rendered pages — layout, tables,
   *    charts, scanned text that is not text at all — which reading the file
   *    with a tool does not recover. The staged copy is still worth having, so
   *    the agent can run something over it.
   *  - **Every other file** appears only as a path in the text, because the
   *    agent reading it beats inlining it. See `describeStagedAttachments`.
   *
   * With none of them the content stays a plain string rather than a
   * one-element block array. The two are equivalent to the API, but the string
   * is what the SDK's own examples send and what every transcript reader in the
   * ecosystem expects to find in the `.jsonl` — including Artemis's own history
   * reader, which would otherwise need a second shape for prompts it wrote.
   *
   * Blocks come *before* the text. Anthropic's guidance is explicit that a
   * question placed before its image is answered worse, and the ordering is
   * free to get right here.
   */
  #userMessage(
    text: string,
    attachments?: readonly Attachment[],
    staged: readonly StagedAttachment[] = [],
  ): SDKUserMessage {
    const all = attachments ?? [];
    const images = all.filter(isImageAttachment);
    const pdfs = all.filter(isPdf);

    // Only the files that are *not* already in the message get named. A PDF
    // rides in as a document block, so pointing the agent at a staged copy
    // would invite a tool call to re-read something it can already see.
    const note = describeStagedAttachments(staged.filter(({ attachment }) => !isPdf(attachment)));
    const body = withAttachmentNote(text, note);

    const blocks: ContentBlockParam[] = [
      ...images.map(
        (image): ImageBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        }),
      ),
      ...pdfs.map(
        (pdf): DocumentBlockParam => ({
          type: 'document',
          source: { type: 'base64', media_type: PDF_MEDIA_TYPE, data: pdf.data },
          // The filename, so the model can refer to it the way the user does
          // and so several attached PDFs are tellable apart.
          title: pdf.name,
        }),
      ),
    ];

    const content: MessageParam['content'] =
      blocks.length === 0
        ? body
        : [
            ...blocks,
            // An empty text block is a 400 from the Messages API, so a prompt
            // that is *only* attachments sends its blocks alone. The composer
            // does not allow that today — Send needs text — but this is a wire
            // format, and "the UI prevents it" is not a reason for the wire to
            // be malformed if it ever stops preventing it.
            ...(body.length === 0 ? [] : [{ type: 'text' as const, text: body }]),
          ];

    return {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  }

  /** Write a turn's files to this run's directory, continuing its numbering. */
  async #stage(attachments?: readonly Attachment[]): Promise<readonly StagedAttachment[]> {
    const files = (attachments ?? []).filter(isFileAttachment);
    if (files.length === 0) return [];
    const staged = await stageAttachments(this.#stagingDir, files, this.#stagedCount);
    this.#stagedCount += files.length;
    return staged;
  }

  /**
   * The permission callback.
   *
   * **This must never return `null`.** The SDK documents `null` as fail-closed:
   * no control response is written, and the tool stays blocked indefinitely
   * because permission prompts have no park deadline. Every path here resolves
   * to an allow or a deny.
   */
  readonly #canUseTool: CanUseTool = async (toolName, input, options) => {
    if (this.#state.ended || this.#disposing !== undefined) {
      return this.#denyResult(DISPOSED_DENY_MESSAGE, options.toolUseID);
    }

    this.#permissionCounter += 1;
    const requestId: PermissionRequestId = `${this.runId}:perm:${String(this.#permissionCounter)}`;
    const deferred = createDeferred<PermissionResult>();

    const request = buildPermissionRequest({
      id: requestId,
      runId: this.runId,
      toolName,
      input,
      info: options,
      requestedAt: this.#deps.now(),
    });

    this.#pending.set(requestId, {
      deferred,
      toolName,
      toolUseID: options.toolUseID,
      // The request's own coerced copy, not the raw SDK object: it is what the
      // renderer was shown, and an answer has to be written back into the same
      // arguments the user was answering.
      input: request.input,
      question: request.question,
    });

    // The provider can withdraw the request (the turn was interrupted, the tool
    // became moot). Settle rather than leak the deferred.
    const onAbort = (): void => {
      this.#pending.delete(requestId);
      deferred.resolve(
        this.#denyResult(WITHDRAWN_DENY_MESSAGE, options.toolUseID),
      );
      // Nobody answered this one, and nobody will. Without saying so on the
      // stream the request stays open everywhere downstream — the registry goes
      // on advertising a prompt that can never be answered, and the card stays
      // on screen over a decision that has already been made elsewhere.
      this.#emitResolved(requestId, 'withdrawn', WITHDRAWN_DENY_MESSAGE);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    this.#emit({
      type: 'permission.request',
      ...nextEventEnvelope(this.#state),
      requestId,
      request,
    });

    try {
      return await deferred.promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
      this.#pending.delete(requestId);
    }
  };

  #denyResult(message: string, toolUseID: string | undefined): PermissionResult {
    return {
      behavior: 'deny',
      message,
      toolUseID,
      decisionClassification: 'user_reject',
    };
  }

  /**
   * Say on the stream that a parked request is no longer parked.
   *
   * Every path that settles one goes through here, because the alternative —
   * remembering to emit at each of the three — is the bug this event exists to
   * fix, one level down. See `PermissionResolvedEvent`.
   *
   * Emitting after `run.end` is a no-op: `#emit` drops onto a closed queue. That
   * is the right answer for the second `#denyAllPending` in `#teardown`, which
   * runs after the stream has already terminated and has nobody left to tell.
   */
  #emitResolved(
    requestId: PermissionRequestId,
    outcome: PermissionResolvedEvent['outcome'],
    note?: string,
    answers?: readonly QuestionAnswer[],
  ): void {
    this.#emit({
      type: 'permission.resolved',
      ...nextEventEnvelope(this.#state),
      requestId,
      outcome,
      ...(note === undefined ? {} : { note }),
      ...(answers === undefined ? {} : { answers }),
    });
  }

  #denyAllPending(message: string): void {
    if (this.#pending.size === 0) return;
    for (const [requestId, entry] of [...this.#pending]) {
      this.#pending.delete(requestId);
      entry.deferred.resolve(this.#denyResult(message, entry.toolUseID));
      // `withdrawn`, not `denied`: the user was never given the choice, and a
      // transcript that recorded this as their refusal would be lying about who
      // decided.
      this.#emitResolved(requestId, 'withdrawn', message);
    }
  }

  #captureStderr(data: string): void {
    for (const line of data.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.#stderrTail.push(scrubSecrets(trimmed));
      if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
    }
  }

  /** Attach the provider's last words to a transport failure, already scrubbed. */
  #withStderr(error: AgentError): AgentError {
    if (this.#stderrTail.length === 0) return error;
    return { ...error, details: { stderr: [...this.#stderrTail] } };
  }
}

/* -------------------------------------------------------------------------- */
/* Session listing plumbing                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Serialises access to `process.env.CLAUDE_CONFIG_DIR`.
 *
 * The SDK's standalone `listSessions()` takes no config-directory option — it
 * resolves the store from the ambient `process.env.CLAUDE_CONFIG_DIR` (falling
 * back to `~/.claude`). Artemis's whole per-profile isolation model depends on
 * pointing it somewhere else, so the variable has to be swapped around the
 * call and restored afterwards.
 *
 * Two concurrent listings for two different profiles would otherwise read each
 * other's history, so calls are queued rather than interleaved. The SDK's own
 * path resolution is memoised *keyed on this variable*, so the swap does take
 * effect rather than being cached away.
 */
let configDirLock: Promise<unknown> = Promise.resolve();

function withClaudeConfigDir<T>(
  configDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const run = configDirLock.then(async () => {
    const previous = process.env[CLAUDE_CONFIG_DIR_ENV];
    if (configDir === undefined) {
      delete process.env[CLAUDE_CONFIG_DIR_ENV];
    } else {
      process.env[CLAUDE_CONFIG_DIR_ENV] = configDir;
    }
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env[CLAUDE_CONFIG_DIR_ENV];
      } else {
        process.env[CLAUDE_CONFIG_DIR_ENV] = previous;
      }
    }
  });

  // Keep the chain alive even when this call fails, or one bad listing would
  // wedge every later one.
  configDirLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/* Session titles                                                             */
/* -------------------------------------------------------------------------- */

/** What a naming query came to: an answer, or why there is not one. */
type TitleAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Drain a naming query down to the one string it produced.
 *
 * The `result` message is what this reads, rather than the assistant text
 * blocks: it is the SDK's own answer for "what did that query come to", it
 * arrives exactly once, and reading it means a model that thought out loud
 * before answering does not have its thinking concatenated onto the title.
 *
 * ## `subtype: 'success'` does not mean it succeeded
 *
 * This is the trap, and it is not hypothetical — it is what an unauthenticated
 * config directory produces, observed verbatim:
 *
 * ```json
 * { "type": "result", "subtype": "success", "is_error": true,
 *   "result": "Not logged in · Please run /login", "terminal_reason": "api_error" }
 * ```
 *
 * A failure arrives wearing the success subtype with `is_error` set beside it,
 * and `result` holds the *error text* in the same field a title would occupy.
 * Reading the subtype alone would have named the user's session
 * `Not logged in · Please run /login` — a string that passes every check in
 * `cleanSessionTitle`, because it is a short, well-formed, capitalised phrase.
 * Both fields are therefore required to agree before the text is believed.
 *
 * Failures are reported rather than swallowed. Returning a bare `null` for all
 * of them is what made a wholly unauthenticated profile look identical to a
 * model that declined to answer: sessions silently stopped being named and
 * nothing anywhere said why.
 */
async function readTitleAnswer(sdkQuery: Query): Promise<TitleAnswer> {
  for await (const message of sdkQuery) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success' || message.is_error) {
      // `result` carries the provider's own explanation on the error path, and
      // it is the only description of the failure anyone will get: the SDK
      // throws on the *next* pull, which a caller that stops here never makes.
      const detail = message.subtype === 'success' ? message.result : message.subtype;
      return { ok: false, reason: detail || 'the provider reported an error' };
    }
    return { ok: true, text: message.result };
  }
  return { ok: false, reason: 'the provider produced no result' };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Reject if `promise` has not settled within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out after ${String(ms)}ms.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wait for `promise`, but give up after `ms`. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A short, scrubbed description of anything thrown. For diagnostics only. */
function describe(error: unknown): string {
  return toAgentError(error).message;
}

/**
 * Does this failure mean "there is no such session" rather than "the delete
 * went wrong"?
 *
 * Only `deleteSession` asks, and only so that deleting something already gone
 * can succeed quietly — see the note there. The test is deliberately narrow in
 * the opposite direction from {@link looksLikeLaunchFailure}: a false positive
 * here reports a *successful* deletion for a transcript that is in fact still
 * on disk, which is the one outcome this feature must never produce. So a
 * permission error, a locked file or a malformed store all fall through to the
 * caller and surface as failures.
 *
 * `ENOENT` is the honest signal and is matched first; the SDK's own wording is
 * matched alongside it because the SDK raises a plain `Error` for a session it
 * cannot locate, with no errno to key on.
 */
function isMissingSession(error: unknown): boolean {
  const code: unknown = (error as { readonly code?: unknown } | null)?.code;
  if (code === 'ENOENT') return true;
  return /\bENOENT\b|session not found|no such session|not found/i.test(describe(error));
}

/**
 * Does this failure look like "the provider process never started"?
 *
 * Deliberately generous. A false positive costs one `stat` and, at worst, an
 * accurate cwd appended to a message that did not need it. A false negative
 * costs the user the libc red herring this whole path exists to replace — so
 * the SDK's own wording (`… exists but failed to launch`) is matched
 * explicitly alongside the errno.
 */
function looksLikeLaunchFailure(error: AgentError): boolean {
  if (error.code === 'provider_not_found') return true;
  return /\bENOENT\b|failed to launch|failed to spawn|\bspawn\b|could not be started|command not found/i.test(
    error.message,
  );
}
