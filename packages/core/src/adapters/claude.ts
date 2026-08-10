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
 * Libra must always use the iterable form, for two reasons that are easy to miss
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
 * `settingSources` defaults to `[]`. Libra is a third-party desktop app, and
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
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  AgentError,
  AgentEvent,
  Capabilities,
  PermissionDecision,
  PermissionRequestId,
  PlanUsage,
  ProfileId,
  ProviderEffortOption,
  ProviderModelOption,
  RunEndReason,
  RunStatus,
  SessionId,
  SessionSummary,
  SystemPromptSpec,
} from '@libra/protocol';
import { NO_CAPABILITIES } from '@libra/protocol';

import { checkWorkingDirectory } from '../workspace/workdir.js';
import { CLAUDE_ENV_SCRUB_KEYS, composeProviderEnv, readEnv } from './env.js';
import {
  CLAUDE_PROVIDER_ID,
  DISPOSED_DENY_MESSAGE,
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
  PlanUsageQuery,
  ProviderAdapter,
  ProviderCredentialSpec,
  ResolvedRunInput,
  Run,
  SendResult,
  SessionListPage,
  SessionListQuery,
  SessionMessagesQuery,
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
  permissionModes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'],
  resumeSession: true, // `Options.resume`
  usageReporting: true, // `result.usage` / `result.modelUsage`
  costReporting: true, // `total_cost_usd` / `ModelUsage.costUSD`
  planUsageReporting: true, // the SDK's structured `/usage` control request
};

/** Env var selecting an isolated Claude config — and therefore session — directory. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Env var carrying a metered API key. Billed per token to the key's account. */
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/**
 * Env var carrying a Claude subscription token.
 *
 * Minted by the user running `claude setup-token` in Anthropic's own CLI, which
 * opens a browser and prints a long-lived token. **Libra never does this**: it
 * implements no OAuth flow, opens no browser for login, and never refreshes the
 * token. The user pastes in what their own CLI printed.
 */
export const CLAUDE_OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * How a Claude credential becomes an environment.
 *
 * This is Claude's vocabulary and it lives with Claude's adapter. The backend
 * list in particular is not universal: `bedrock`, `vertex` and `foundry` are
 * places *Anthropic's* models are hosted, and the flags that select them are
 * read by the Claude CLI and nothing else.
 *
 * `anthropic` is first, which makes it the default, and it is the only backend
 * that needs a stored credential — the cloud backends authenticate from the
 * ambient AWS, GCP or Azure credential chain, so nothing is read for them even
 * if a secret happens to be stored. It has no flag of its own: it is selected
 * by the *absence* of the other three.
 *
 * ## The two auth modes, and the trap between them
 *
 * `api-key` writes the secret to `ANTHROPIC_API_KEY` and bills metered API
 * usage. `subscription` writes it to `CLAUDE_CODE_OAUTH_TOKEN` and bills a
 * Claude Pro/Max/Team/Enterprise plan.
 *
 * They are not symmetric. **`ANTHROPIC_API_KEY`, when set, overrides the
 * subscription token**: with both present the run is billed as metered API
 * usage even though the user chose the subscription. So it is not enough for
 * subscription mode to set its own variable — the API key variable has to be
 * *absent*, including when it was merely inherited from the user's shell.
 * `managedEnvKeys` covers both variables for exactly that reason, and
 * `resolveEnv` writes back only the selected mode's.
 *
 * `ANTHROPIC_AUTH_TOKEN` stays managed-and-always-stripped: it is a third
 * credential path Libra does not expose, and leaving it inheritable would let
 * ambient state pick an account no profile named.
 */
export const CLAUDE_CREDENTIALS: ProviderCredentialSpec = {
  apiKeyVar: CLAUDE_API_KEY_ENV,
  configDirVar: CLAUDE_CONFIG_DIR_ENV,
  /*
    Always stripped, never set.

    `CLAUDE_CODE_OAUTH_TOKEN` moved here when subscription mode stopped
    emitting it. Libra no longer produces this variable in any mode — the CLI's
    own per-profile login supplies the credential — but it must still be
    removed from the inherited environment, because an explicitly-set token
    outranks the config directory's login. Left alone, a token sitting in the
    user's shell would silently decide which account a profile uses.

    `ANTHROPIC_AUTH_TOKEN` is here for the same reason: a third credential path
    Libra does not expose, which ambient state must not be able to select.
  */
  extraManagedEnvKeys: ['ANTHROPIC_AUTH_TOKEN', CLAUDE_OAUTH_TOKEN_ENV],
  authModes: [
    {
      id: 'console',
      label: 'Console account',
      note: 'Metered API usage, billed to the signed-in Console account.',
      /*
        Also no stored secret — the same CLI login, with `--console` instead of
        `--claudeai`.

        This replaced a pasted-API-key mode. Two things were wrong with that:
        the key sat in Libra's own store, and `ANTHROPIC_API_KEY` *overrides* a
        subscription login, so a profile meant to bill a plan would silently
        bill API credit instead. Neither is fixable while Libra holds the
        credential, so it no longer does.
      */
      requiresSecret: false,
      backends: ['anthropic'],
      secretHowTo:
        'Sign in with the button above. Libra runs `claude auth login --console` against this profile’s own config directory; the browser flow happens in Anthropic’s CLI and no credential passes through Libra.',
    },
    {
      id: 'cloud',
      label: 'Cloud credentials',
      note: 'Billed by the cloud account. Uses that provider’s own credential chain.',
      /*
        The cloud backends do not authenticate through Anthropic at all: Bedrock
        reads the AWS chain, Vertex the Google one, Foundry the Azure one, each
        from ambient configuration Libra does not manage. So there is nothing to
        sign in to here and nothing to store — the mode exists to say that
        plainly, rather than leaving these backends with no selectable mode.
      */
      requiresSecret: false,
      backends: ['bedrock', 'vertex', 'foundry'],
      secretHowTo:
        'Nothing to enter. Configure the cloud provider’s own credentials as you normally would — AWS for Bedrock, gcloud for Vertex, Azure for Foundry — and Libra’s run inherits them.',
    },
    {
      id: 'subscription',
      label: 'Claude subscription',
      note: 'Billed against a Claude Pro, Max, Team or Enterprise plan instead of API credit.',
      /*
        No stored secret, by design.

        The credential is created by `claude auth login` run with this
        profile's `CLAUDE_CONFIG_DIR`, and it lives with the CLI — Libra never
        sees, stores or emits it. Verified on macOS: three config directories
        report three independent answers, so the login genuinely scopes to the
        profile and multiple accounts still work.

        Emitting `CLAUDE_CODE_OAUTH_TOKEN` here would actively break that,
        because an explicitly-set token overrides whatever the config directory
        holds — a stale pasted value would silently beat a good login.
      */
      requiresSecret: false,
      // Subscription billing exists only on Anthropic's first-party API. A
      // Bedrock or Vertex run is billed by that cloud, so the combination is a
      // contradiction rather than an unsupported feature.
      backends: ['anthropic'],
      secretHowTo:
        'Sign in with the button above. Libra runs `claude auth login` against this profile’s own config directory, so the browser flow happens in Anthropic’s CLI and the credential never passes through Libra.',
    },
  ],
  backends: [
    {
      id: 'anthropic',
      label: 'Anthropic API',
      note: 'Anthropic’s first-party API. A credential is required.',
      requiresApiKey: true,
      envFlag: null,
    },
    {
      id: 'bedrock',
      label: 'AWS Bedrock',
      note: 'Uses the ambient AWS credential chain.',
      requiresApiKey: false,
      envFlag: 'CLAUDE_CODE_USE_BEDROCK',
    },
    {
      id: 'vertex',
      label: 'Google Vertex AI',
      note: 'Uses ambient Google Cloud credentials.',
      requiresApiKey: false,
      envFlag: 'CLAUDE_CODE_USE_VERTEX',
    },
    {
      id: 'foundry',
      label: 'Microsoft Foundry',
      note: 'Uses ambient Foundry credentials.',
      requiresApiKey: false,
      envFlag: 'CLAUDE_CODE_USE_FOUNDRY',
    },
  ],
};

/**
 * Models the picker offers, in display order. First entry is the default.
 *
 * **Aliases, not dated snapshot ids.** `sonnet` resolves to whatever the
 * installed CLI considers the current Sonnet; `claude-sonnet-4-5-20250929` is
 * frozen and goes stale in a way nobody notices until a run fails. A picker
 * that has to be edited on every model release is a picker that will be wrong.
 *
 * This list is what the UI *offers*. It is not an allow-list: `RunInput.model`
 * stays open, so a user or a future settings screen can still name a specific
 * snapshot and have it passed straight through — see {@link validateRunInput},
 * which deliberately does not check it.
 */
export const CLAUDE_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'default',
    label: 'Default',
    note: 'Whatever the installed Claude CLI selects — usually the current Sonnet.',
  },
  {
    id: 'opus',
    label: 'Opus',
    note: 'The most capable model. Slowest and most expensive per token.',
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    note: 'The balanced default: strong on code, much cheaper than Opus.',
  },
  {
    id: 'haiku',
    label: 'Haiku',
    note: 'Fastest and cheapest. Best for small, mechanical edits.',
  },
];

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

  return {
    id: CLAUDE_PROVIDER_ID,
    label: 'Claude',
    capabilities: CLAUDE_CAPABILITIES,
    credentials: CLAUDE_CREDENTIALS,
    models: CLAUDE_MODELS,
    effortLevels: CLAUDE_EFFORT_LEVELS,

    async createRun(input: ResolvedRunInput): Promise<Run> {
      validateRunInput(input);
      const run = new ClaudeRun(input, { now, hostEnv, diagnostic });
      run.start();
      return run;
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
     * would be a guess. Since every Libra profile has its own
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

  // Identify Libra in the provider's User-Agent, unless the profile already
  // chose an identifier.
  env['CLAUDE_AGENT_SDK_CLIENT_APP'] ??= 'libra';

  const permissionMode = input.permissionMode;

  return {
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
}

interface ClaudeRunDeps {
  readonly now: () => number;
  readonly hostEnv?: EnvBundle;
  readonly diagnostic?: (message: string, detail?: unknown) => void;
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

  constructor(input: ResolvedRunInput, deps: ClaudeRunDeps) {
    this.#input = input;
    this.#deps = deps;
    this.runId = input.runId;

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
    this.#promptQueue.push(this.#userMessage(this.#input.prompt));

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
  async send(text: string): Promise<SendResult> {
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

    this.#promptQueue.push(this.#userMessage(text));
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
    });

    if (droppedUpdates.length > 0) {
      // The SDK's deny branch has no `updatedPermissions` field, so a "never
      // allow this" rule attached to a denial cannot be forwarded.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: ${String(droppedUpdates.length)} permission update(s) could not be persisted with a denial.`,
      );
    }

    entry.deferred.resolve(result);
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

    // 6. Guarantee the contract even if the SDK never came back at all: exactly
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

  /** Libra's own intent outranks whatever the transport reports. */
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

  #userMessage(text: string): SDKUserMessage {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
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

    this.#pending.set(requestId, {
      deferred,
      toolName,
      toolUseID: options.toolUseID,
    });

    // The provider can withdraw the request (the turn was interrupted, the tool
    // became moot). Settle rather than leak the deferred.
    const onAbort = (): void => {
      this.#pending.delete(requestId);
      deferred.resolve(
        this.#denyResult('The provider withdrew this tool call.', options.toolUseID),
      );
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    this.#emit({
      type: 'permission.request',
      ...nextEventEnvelope(this.#state),
      requestId,
      request: buildPermissionRequest({
        id: requestId,
        runId: this.runId,
        toolName,
        input,
        info: options,
        requestedAt: this.#deps.now(),
      }),
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

  #denyAllPending(message: string): void {
    if (this.#pending.size === 0) return;
    for (const [requestId, entry] of [...this.#pending]) {
      this.#pending.delete(requestId);
      entry.deferred.resolve(this.#denyResult(message, entry.toolUseID));
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
 * back to `~/.claude`). Libra's whole per-profile isolation model depends on
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
