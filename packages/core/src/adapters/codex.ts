/**
 * The Codex adapter: a subprocess speaking JSON-RPC, normalized into the seam.
 *
 * `codexMapper.ts` is the meaning; this file is the plumbing — the app-server
 * process, the initialize handshake, the thread and turn lifecycle, the
 * approval deferreds, and disposal.
 *
 * ## Why one process per run
 *
 * `codex app-server` can hold many threads at once, so a single long-lived
 * process serving every run would save a spawn. It would also make one run's
 * crash everyone's crash, and put Artemis in the business of multiplexing
 * notifications by `threadId` — with the failure mode that a routing bug sends
 * one conversation's output into another's transcript.
 *
 * A run already owns a process boundary in the Claude adapter (the SDK spawns
 * one per query), the seam is built around per-run isolation, and a spawn costs
 * milliseconds against turns that take seconds. So: one process per run, torn
 * down with it. `listModels`, `listSessions` and `fetchPlanUsage` each open
 * their own short-lived one through {@link withAppServer}.
 *
 * ## Secrets
 *
 * `ResolvedRunInput.env` is the only channel a credential travels on, and this
 * file never reads one. It sets `CODEX_HOME` — which is what scopes a profile's
 * login *and* its history — and strips every variable that could authenticate
 * the CLI some other way. Artemis holds no Codex credential at all: `codex login`
 * writes one into the profile's own directory and this adapter reads a boolean
 * back.
 */

import type {
  AgentError,
  AgentEvent,
  Attachment,
  Capabilities,
  ImageAttachment,
  ImageMediaType,
  JsonObject,
  JsonValue,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PermissionRequestId,
  PlanUsage,
  PlanUsageWindow,
  ProviderEffortOption,
  ProviderModelOption,
  RunStatus,
  SessionId,
  SessionSummary,
} from '@rx-artemis/protocol';
import { isFileAttachment, isImageAttachment, NO_CAPABILITIES } from '@rx-artemis/protocol';

import {
  createStagingDirectory,
  describeStagedAttachments,
  removeStagingDirectory,
  stageAttachments,
  withAttachmentNote,
} from './attachments.js';

import { composeProviderEnv, readEnv } from './env.js';
import {
  CODEX_METHOD,
  CODEX_SERVER_REQUEST,
  asRecord,
  readNumber,
  readString,
} from './codexProtocol.js';
import type {
  CodexAskForApproval,
  CodexLocalImageInput,
  CodexReasoningEffort,
  CodexSandboxPolicy,
  CodexTextInput,
  CodexUserInput,
} from './codexProtocol.js';
import {
  CODEX_PROVIDER_ID,
  createCodexMapperState,
  finalizeCodexRun,
  flushCodexToolCalls,
  mapCodexNotification,
  nextCodexEventEnvelope,
  replayCodexItem,
} from './codexMapper.js';
import type { CodexMapperState } from './codexMapper.js';
import { JsonRpcError, spawnJsonRpcSubprocess } from './jsonrpc.js';
import type { IncomingRequest, JsonRpcSubprocess } from './jsonrpc.js';
import { AsyncQueue, createDeferred } from './stream.js';
import type { Deferred } from './stream.js';
import { adapterError, toAgentError } from './types.js';
import type {
  AdapterAvailability,
  AggregatedSessionList,
  AllSessionsQuery,
  AuthStatus,
  EnvBundle,
  InterruptResult,
  ModelCatalogue,
  ModelListQuery,
  PlanUsageQuery,
  ProbeResult,
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

/** The executable, resolved on `PATH`. */
export const CODEX_EXECUTABLE = 'codex';

/**
 * How long to wait for the initialize handshake before giving up.
 *
 * Generous, because a cold `codex` start also loads MCP servers — the probe
 * against a real install emitted six `mcpServer/startupStatus/updated`
 * notifications before the first turn could begin.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** How long a metadata probe (`model/list`, rate limits) may take. */
const PROBE_TIMEOUT_MS = 20_000;

/** How long to wait for a turn to interrupt before forcing teardown. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** How long to let the app server exit cleanly during dispose. */
const DISPOSE_GRACE_MS = 4_000;

/**
 * What the Codex adapter can do, measured against the real app server rather
 * than inferred from documentation.
 *
 * `subagents` is false because although Codex has collab agents, Artemis does
 * not map their items yet — advertising it would promise nesting the transcript
 * cannot render. `costReporting` is false because the protocol reports tokens
 * and rate-limit percentages but never a price.
 */
export const CODEX_CAPABILITIES: Capabilities = {
  ...NO_CAPABILITIES,
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  resumeSession: true,
  usageReporting: true,
  planUsageReporting: true,
  subagents: false,
  costReporting: false,
  imageInput: true, // `localImage` input items, staged to temp files
  fileInput: true, // staged to a granted temp directory and named in the prompt
  permissionModes: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
};

/**
 * The variable that scopes a profile.
 *
 * Codex keeps the credential (`auth.json`), the session history (`sessions/`)
 * and the config (`config.toml`) all under this one directory, so pointing it
 * at a per-profile path isolates all three at once — the same property that
 * makes `CLAUDE_CONFIG_DIR` load-bearing for the Claude adapter.
 *
 * **The directory must already exist.** Codex refuses to start otherwise,
 * with `Error loading configuration: CODEX_HOME points to "…", but that path
 * does not exist` — it will not create one. Artemis's profile store is
 * responsible for making it before the first run.
 */
export const CODEX_HOME_ENV = 'CODEX_HOME';

/**
 * Credential and routing variables stripped from the inherited environment.
 *
 * Every one of these is a way to authenticate or redirect the CLI without going
 * through the profile's `CODEX_HOME`, and each outranks it. An `OPENAI_API_KEY`
 * exported in the user's shell would bill metered API usage against the
 * subscription the profile just signed into — the exact trap
 * `CLAUDE_ENV_SCRUB_KEYS` exists to prevent on the other side.
 *
 * Strip-only: Artemis sets none of them, so there is no case where one is
 * removed and then written back.
 */
export const CODEX_CREDENTIAL_ENVS: readonly string[] = [
  // credentials
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  // endpoint overrides that change which account or route is billed
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  // storage location — the thing that makes profiles isolated at all
  'CODEX_HOME',
];

/**
 * Read `codex login status`.
 *
 * The reason {@link ProviderSignInSpec.parseStatus} exists. Codex prints a
 * sentence rather than JSON and offers no `--json` flag, so the default reader —
 * which expects Claude's object — would report every signed-in Codex profile as
 * signed out and tell the user to run a login they had already run.
 *
 * Measured against `codex-cli 0.142.3`:
 *
 * ```
 * $ codex login status            → "Logged in using ChatGPT"   exit 0
 * $ CODEX_HOME=/fresh …           → "Not logged in"             exit 1
 * ```
 *
 * Two traps, both of which cost a wrong answer before being found:
 *
 *  - **The status goes to `stderr`, not `stdout`.** `codex login status 2>&1`
 *    hides this completely, which is exactly how it survived the first reading.
 *    Both streams are searched.
 *  - **The exit code is not the signal.** Signed-out exits `1`, and so does a
 *    genuine failure. Only the text distinguishes them.
 *
 * Anything unrecognised becomes an `error` rather than a confident "signed
 * out": a wrong "signed out" sends the user round a login they have already
 * completed, while a wrong error at least says what it saw.
 */
export function parseCodexAuthStatus(result: ProbeResult): AuthStatus {
  const text = `${result.stdout}\n${result.stderr}`;

  // Checked first: "Not logged in" contains "logged in".
  if (/\bnot logged in\b/i.test(text)) {
    return { loggedIn: false, authMethod: 'none' };
  }

  const match = /\blogged in(?:\s+using\s+(.+?))?\s*$/im.exec(text);
  if (match !== null) {
    const method = match[1]?.trim();
    return {
      loggedIn: true,
      // Normalised to the vocabulary `getAuthStatus` uses over the app server,
      // so the two paths cannot disagree about what the same account is.
      authMethod: method === undefined ? 'unknown' : normaliseAuthMethod(method),
    };
  }

  if (/CODEX_HOME points to/i.test(text)) {
    return {
      loggedIn: false,
      error: 'This profile’s Codex directory does not exist yet.',
    };
  }

  return {
    loggedIn: false,
    error:
      firstLine(text) === ''
        ? 'The Codex CLI did not report a sign-in status.'
        : `Unexpected sign-in status: ${firstLine(text)}`,
  };
}

function normaliseAuthMethod(method: string): string {
  const lowered = method.toLowerCase();
  if (lowered.includes('chatgpt')) return 'chatgpt';
  if (lowered.includes('api key')) return 'apikey';
  return lowered;
}

/**
 * How a Codex profile signs in.
 *
 * Artemis performs no login here either: `codex login`, run with `CODEX_HOME`
 * pointed at the profile's directory, writes a credential Artemis never sees.
 * Artemis sets one variable and reads a boolean back.
 */
export const CODEX_CREDENTIALS: ProviderCredentialSpec = {
  configDirVar: CODEX_HOME_ENV,
  credentialEnvKeys: CODEX_CREDENTIAL_ENVS,
  signIn: {
    executable: CODEX_EXECUTABLE,
    loginArgs: ['login'],
    statusArgs: ['login', 'status'],
    logoutArgs: ['logout'],
    parseStatus: parseCodexAuthStatus,
    howTo:
      'Runs Codex’s own sign-in against this profile’s config directory. Your browser opens to authorise ChatGPT, and the credential is written into the profile — Artemis never sees it.',
  },
};

/**
 * The built-in model list.
 *
 * A *fallback*, superseded by {@link ProviderAdapter.listModels} the moment the
 * CLI answers. Kept short on purpose: the live catalogue is authoritative and
 * arrives within a second on any machine that can run a turn at all, so this
 * only has to cover the window before it lands and the case where the CLI
 * cannot be reached.
 *
 * Transcribed from a live `model/list` against `codex-cli 0.142.3`.
 */
export const CODEX_MODELS: readonly ProviderModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    displayName: 'GPT-5.5',
    note: 'Frontier model for complex coding, research, and real-world work.',
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    tier: 1,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    displayName: 'GPT-5.4 mini',
    note: 'Faster and cheaper, for routine edits and quick questions.',
    effortLevels: ['low', 'medium', 'high'],
    // Ordinals within *this* catalogue and nothing more — see
    // `ProviderModelOption.tier`. "mini" is Codex's own word for the small one.
    tier: 0,
  },
];

/** Reasoning-effort levels, least to most. Codex calls these `reasoningEffort`. */
export const CODEX_EFFORT_LEVELS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Fast responses with lighter reasoning.' },
  { id: 'medium', label: 'Medium', note: 'Balances speed and reasoning depth for everyday tasks.' },
  { id: 'high', label: 'High', note: 'Greater reasoning depth for complex problems.' },
  { id: 'xhigh', label: 'Extra high', note: 'Maximum reasoning depth. Slowest.' },
];

const EFFORT_IDS = new Set(CODEX_EFFORT_LEVELS.map((level) => level.id));

/* -------------------------------------------------------------------------- */
/* Permission mapping                                                         */
/* -------------------------------------------------------------------------- */

/** Codex's two axes, recovered from one Artemis permission mode. */
export interface CodexPermissions {
  readonly approvalPolicy: CodexAskForApproval;
  readonly sandboxPolicy: CodexSandboxPolicy;
}

/**
 * Collapse Artemis's single permission axis onto Codex's two.
 *
 * ## The mismatch
 *
 * Artemis's `PermissionMode` came from the Claude SDK, which folds "must it ask
 * first?" and "what may it touch?" into one knob. Codex separates them:
 * `AskForApproval` decides when to prompt, `SandboxPolicy` decides what is
 * reachable at all. Every Artemis mode therefore picks a *pair*.
 *
 * ## Why `dontAsk` and `auto` are not offered
 *
 * `CODEX_CAPABILITIES.permissionModes` advertises four of the six modes, and
 * the two omissions are the interesting part.
 *
 * `dontAsk` is documented as "never prompt; **denies** instead of asking".
 * Codex's nearest neighbour is `never`, which never prompts and **proceeds**
 * within the sandbox. Those are opposites at exactly the moment they matter, and
 * mapping one to the other would make Artemis silently more permissive than the
 * user asked for — the specific failure `ProviderAdapter.createRun` is required
 * to reject rather than degrade into.
 *
 * `auto` describes a provider-side risk classifier. Codex has no equivalent, and
 * `on-failure` (prompt only once a sandboxed command has already failed) is a
 * different idea wearing similar clothes.
 *
 * A mode outside the advertised list is rejected by {@link validateRunInput},
 * not quietly substituted.
 */
export function toCodexPermissions(
  mode: PermissionMode | undefined,
  options: { readonly cwd: string; readonly additionalDirectories?: readonly string[] },
): CodexPermissions {
  const writableRoots = [options.cwd, ...(options.additionalDirectories ?? [])];
  const workspaceWrite: CodexSandboxPolicy = {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };

  switch (mode) {
    case 'plan':
      // Research and propose only. `readOnly` is what actually enforces it —
      // `never` alone would let the agent run mutating commands unprompted.
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };

    case 'acceptEdits':
      // Edits land without a prompt because the sandbox already permits them;
      // anything needing to escape the sandbox still asks.
      return { approvalPolicy: 'on-request', sandboxPolicy: workspaceWrite };

    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };

    case 'default':
    case undefined:
      // `untrusted` prompts for anything not already on Codex's trusted list,
      // which is the closest match to "prompt for anything not already allowed".
      return { approvalPolicy: 'untrusted', sandboxPolicy: workspaceWrite };

    default:
      return { approvalPolicy: 'untrusted', sandboxPolicy: workspaceWrite };
  }
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Options for {@link createCodexAdapter}. */
export interface CodexAdapterOptions {
  /** Injectable clock, used for every `ts` and every duration. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** The environment to inherit from. Defaults to `process.env`. Injectable for tests. */
  readonly hostEnv?: EnvBundle;
  /** Override the executable. Defaults to `codex` on `PATH`. */
  readonly executable?: string;
  /** Sink for things worth knowing but not worth surfacing. Never called with a secret. */
  readonly onDiagnostic?: (message: string, detail?: unknown) => void;
}

/**
 * Create the Codex adapter.
 *
 * Stateless with respect to runs: one instance serves every run, and all
 * per-run state lives on the {@link Run} objects it returns.
 */
export function createCodexAdapter(options?: CodexAdapterOptions): ProviderAdapter {
  const now = options?.now ?? Date.now;
  const hostEnv = options?.hostEnv;
  const executable = options?.executable ?? CODEX_EXECUTABLE;
  const diagnostic = options?.onDiagnostic;

  const deps: CodexRunDeps = {
    now,
    executable,
    ...(hostEnv === undefined ? {} : { hostEnv }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };

  return {
    id: CODEX_PROVIDER_ID,
    label: 'Codex',
    capabilities: CODEX_CAPABILITIES,
    credentials: CODEX_CREDENTIALS,
    models: CODEX_MODELS,
    effortLevels: CODEX_EFFORT_LEVELS,

    /*
     * Meets the two obligations on `ProviderAdapter.listModels`: `model/list` is
     * a control-channel call that never samples the model, and every failure
     * path resolves with the built-in list rather than rejecting — a machine
     * with no CLI, no credential or no network is an ordinary state of a desktop
     * and must not empty the model picker.
     */
    async listModels(query: ModelListQuery): Promise<ModelCatalogue> {
      try {
        const response = await withAppServer(
          {
            deps,
            env: query.env,
            cwd: query.cwd,
            ...(query.inheritHostEnv === undefined ? {} : { inheritHostEnv: query.inheritHostEnv }),
          },
          async (session) => session.request(CODEX_METHOD.modelList, {}),
        );

        const models = parseModelList(response);
        if (models.length === 0) {
          diagnostic?.('Codex returned an empty model list; using the built-in one.');
          return { models: CODEX_MODELS, live: false };
        }
        return { models, live: true };
      } catch (error) {
        diagnostic?.('Could not read the Codex model catalogue.', describe(error));
        return { models: CODEX_MODELS, live: false };
      }
    },

    async createRun(input: ResolvedRunInput): Promise<Run> {
      validateCodexRunInput(input);

      // Created for every run, attachments or not, and granted before the first
      // turn: the sandbox policy is built once from `additionalDirectories`, so
      // a directory created later — when the user attaches to a mid-run steer —
      // would be outside the roots the turn was started with.
      const directory = await createStagingDirectory();

      try {
        const run = new CodexRun(
          {
            ...input,
            additionalDirectories: [...(input.additionalDirectories ?? []), directory],
          },
          deps,
          directory,
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
      const limit = request.limit;
      const offset = request.offset ?? 0;

      const response = await withAppServer(
        { deps, env: request.env, cwd: request.cwd },
        async (session) =>
          session.request(CODEX_METHOD.threadList, {
            cwd: request.cwd,
            // Over-fetch so `hasMore` is a fact rather than a guess, and so the
            // offset can be applied client-side: the protocol paginates by
            // cursor, which cannot express "skip n".
            ...(limit === undefined ? {} : { limit: offset + limit + 1 }),
          }),
      ).catch((error: unknown) => {
        throw adapterError('unknown', `Could not read Codex session history: ${describe(error)}`, {
          cause: error,
        });
      });

      const all = parseThreadList(response, request.profileId, request.cwd);
      const window = all.slice(offset);
      const hasMore = limit !== undefined && window.length > limit;

      return {
        sessions: limit === undefined ? window : window.slice(0, limit),
        hasMore,
      };
    },

    /**
     * Every session in every project, for every profile asked about.
     *
     * Straightforward here in a way it is not for Claude: `thread/list` returns
     * each thread's `cwd` as a real field, so there is no lossy directory-name
     * encoding to decode and no session that has to be dropped for want of a
     * recoverable working directory.
     *
     * One bad profile must not fail the query — a profile whose `CODEX_HOME` was
     * deleted contributes nothing and is named in `unreadableProfiles`.
     */
    async listAllSessions(request: AllSessionsQuery): Promise<AggregatedSessionList> {
      const sessions: SessionSummary[] = [];
      const unreadableProfiles: SessionSummary['profileId'][] = [];

      await Promise.all(
        request.profiles.map(async (scope) => {
          const configDir = readEnv(scope.env, CODEX_HOME_ENV);
          try {
            const response = await withAppServer(
              // No project scope, so the probe needs *a* directory to start in.
              // The profile's own config directory is guaranteed to exist —
              // Codex refuses to start otherwise — which is more than can be
              // said for any workspace path we might guess at.
              { deps, env: scope.env, cwd: configDir ?? process.cwd() },
              async (session) => session.request(CODEX_METHOD.threadList, {}),
            );
            sessions.push(...parseThreadList(response, scope.profileId, undefined));
          } catch (error) {
            diagnostic?.(
              `Could not read Codex history for profile ${scope.profileId}.`,
              describe(error),
            );
            unreadableProfiles.push(scope.profileId);
          }
        }),
      );

      sessions.sort(byNewestThenId);
      return { sessions, unreadableProfiles };
    },

    async getSessionMessages(query: SessionMessagesQuery): Promise<SessionTranscript> {
      const state = createCodexMapperState(query.runId, { now });

      const response = await withAppServer(
        { deps, env: query.env, cwd: query.cwd ?? process.cwd() },
        async (session) =>
          session.request(CODEX_METHOD.threadRead, {
            threadId: query.sessionId,
            includeTurns: true,
          }),
      ).catch((error: unknown) => {
        throw adapterError('unknown', `Could not read the Codex session: ${describe(error)}`, {
          cause: error,
        });
      });

      const thread = asRecord(asRecord(response)['thread']);
      const turns = Array.isArray(thread['turns']) ? (thread['turns'] as unknown[]) : [];

      const events: AgentEvent[] = [];
      for (const turn of turns) {
        const items = Array.isArray(asRecord(turn)['items'])
          ? (asRecord(turn)['items'] as unknown[])
          : [];
        for (const item of items) {
          events.push(...replayCodexItem(item as never, state));
        }
      }

      const offset = query.offset ?? 0;
      const limit = query.limit;
      const window = events.slice(offset);

      return {
        events: limit === undefined ? window : window.slice(0, limit),
        hasMore: limit !== undefined && window.length > limit,
      };
    },

    /*
     * No `suggestSessionTitle` / `setSessionTitle`, and the absence is the
     * whole answer rather than a gap waiting to be filled.
     *
     * A thread already carries a `name` — `parseThreadList` reads it, and a
     * named thread is reported with `titleIsCustom` — but the app server
     * publishes no method that *writes* one: `thread/start`, `resume`, `fork`,
     * `read` and `list` are the whole surface Artemis speaks, and none of them
     * takes a title. Generating a name Artemis could not store would spend the
     * user's account on a string with nowhere to go, so both halves are omitted
     * together and `SessionNamer` skips this provider. Codex threads keep the
     * label they have always had: the thread's own name, else its preview.
     */
    async checkAvailability(): Promise<AdapterAvailability> {
      try {
        const version = await readCodexVersion(executable, hostEnv);
        if (version === undefined) {
          return {
            available: false,
            unavailableReason:
              'The Codex CLI was not found on your PATH. Install it, then reopen this window.',
          };
        }
        return { available: true };
      } catch (error) {
        return {
          available: false,
          unavailableReason: `Could not run the Codex CLI: ${describe(error)}`,
        };
      }
    },

    /**
     * How much of the plan is gone.
     *
     * Meets all three obligations on `ProviderAdapter.fetchPlanUsage`:
     * `account/rateLimits/read` is a control-channel call that never samples the
     * model; a profile on metered API billing reports `available: false` rather
     * than throwing; and a protocol that stops answering degrades to unavailable
     * instead of breaking the caller.
     *
     * Notably sturdier than the Claude equivalent, which has to reach an
     * experimental SDK method through a tolerant name lookup — this one is a
     * first-class method with a stable name.
     */
    async fetchPlanUsage(input: PlanUsageQuery): Promise<PlanUsage> {
      const fetchedAt = now();
      try {
        const response = await withAppServer(
          { deps, env: input.env, cwd: input.cwd },
          async (session) => session.request(CODEX_METHOD.accountRateLimitsRead, {}),
        );

        const limits = asRecord(asRecord(response)['rateLimits']);
        if (Object.keys(limits).length === 0) {
          return {
            available: false,
            unavailableReason: 'This account does not report plan limits.',
            windows: [],
            fetchedAt,
          };
        }

        const windows = parseRateLimitWindows(limits);
        const planType = readString(limits, 'planType');

        if (windows.length === 0) {
          return {
            available: false,
            unavailableReason:
              planType === undefined
                ? 'This account does not report plan limits.'
                : `Usage on the ${planType} plan is metered rather than capped.`,
            ...(planType === undefined ? {} : { subscriptionType: planType }),
            windows: [],
            fetchedAt,
          };
        }

        return {
          available: true,
          ...(planType === undefined ? {} : { subscriptionType: planType }),
          windows,
          fetchedAt,
        };
      } catch (error) {
        diagnostic?.('Could not read Codex plan usage.', describe(error));
        return {
          available: false,
          unavailableReason: 'Codex did not report plan limits for this profile.',
          windows: [],
          fetchedAt,
        };
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reject anything the adapter cannot honour, before a process is spawned.
 *
 * Exported for testing: every check here is meant to fire *ahead* of any side
 * effect, and the only way to prove that is to call it without one.
 */
export function validateCodexRunInput(input: ResolvedRunInput): void {
  if (!isAbsolutePath(input.cwd)) {
    throw adapterError('invalid_request', `cwd must be an absolute path, got "${input.cwd}".`);
  }

  if (
    input.permissionMode !== undefined &&
    !CODEX_CAPABILITIES.permissionModes.includes(input.permissionMode)
  ) {
    // Deliberately not downgraded to the nearest supported mode: see
    // `toCodexPermissions` for why `dontAsk` in particular must not be
    // approximated.
    throw adapterError(
      'invalid_request',
      `Codex does not support the "${input.permissionMode}" permission mode. Supported modes: ${CODEX_CAPABILITIES.permissionModes.join(', ')}.`,
    );
  }

  if (input.resumeSessionId !== undefined && !CODEX_CAPABILITIES.resumeSession) {
    throw adapterError('invalid_request', 'Codex cannot resume sessions.');
  }

  if (input.forkSession === true && !CODEX_CAPABILITIES.forkSession) {
    throw adapterError('invalid_request', 'Codex cannot fork sessions.');
  }

  if (input.effort !== undefined && !EFFORT_IDS.has(input.effort)) {
    throw adapterError(
      'invalid_request',
      `Codex does not offer the "${input.effort}" effort level. Supported levels: ${[...EFFORT_IDS].join(', ')}.`,
    );
  }
}

/**
 * Absolute-path test that does not depend on the host platform.
 *
 * `node:path`'s `isAbsolute` answers for whichever platform it is running on,
 * so a Windows path checked on a macOS test runner reads as relative. Both
 * shapes are accepted here because the *provider* is what will reject a bad
 * one, and this check exists to catch the obvious mistake, not to second-guess
 * the filesystem.
 */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/* -------------------------------------------------------------------------- */
/* App-server session                                                         */
/* -------------------------------------------------------------------------- */

interface CodexRunDeps {
  readonly now: () => number;
  readonly executable: string;
  readonly hostEnv?: EnvBundle;
  readonly diagnostic?: (message: string, detail?: unknown) => void;
}

/** A connected, initialized app server. */
interface AppServerSession {
  request(method: string, params?: JsonValue): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): void;
  readonly process: JsonRpcSubprocess;
}

interface OpenAppServerOptions {
  readonly deps: CodexRunDeps;
  readonly env: EnvBundle;
  readonly cwd: string;
  readonly inheritHostEnv?: boolean;
  readonly onNotification?: (method: string, params: JsonValue | undefined) => void;
  readonly onRequest?: (request: IncomingRequest) => Promise<JsonValue>;
  readonly onExit?: (reason: string) => void;
}

/**
 * Spawn `codex app-server` and complete its handshake.
 *
 * The handshake is mandatory and ordered: a single `initialize` request, then an
 * `initialized` notification, before any other method. The server rejects
 * anything sent ahead of it.
 */
async function openAppServer(options: OpenAppServerOptions): Promise<AppServerSession> {
  const env = composeProviderEnv(options.env, {
    ...(options.inheritHostEnv === undefined ? {} : { inheritHostEnv: options.inheritHostEnv }),
    ...(options.deps.hostEnv === undefined ? {} : { hostEnv: options.deps.hostEnv }),
    scrubKeys: CODEX_CREDENTIAL_ENVS,
  });

  const child = spawnJsonRpcSubprocess({
    executable: options.deps.executable,
    args: ['app-server'],
    cwd: options.cwd,
    env,
    ...(options.onNotification === undefined ? {} : { onNotification: options.onNotification }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    ...(options.deps.diagnostic === undefined ? {} : { onDiagnostic: options.deps.diagnostic }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });

  const session: AppServerSession = {
    request: (method, params) => child.connection.request(method, params),
    notify: (method, params) => {
      child.connection.notify(method, params);
    },
    process: child,
  };

  try {
    await withTimeout(
      child.connection.request(CODEX_METHOD.initialize, {
        clientInfo: { name: 'artemis', title: 'Artemis', version: '0.1.0' },
        // No `experimentalApi`: opting in would let a CLI upgrade change the
        // shape of methods a shipped Artemis build depends on.
        capabilities: {},
      }),
      HANDSHAKE_TIMEOUT_MS,
      'The Codex app server did not answer the initialize handshake.',
    );
    session.notify('initialized', {});
  } catch (error) {
    await child.dispose();
    throw enrichLaunchFailure(error, child.stderrTail(), options.deps.executable);
  }

  return session;
}

/** Open an app server, run one thing against it, and always tear it down. */
async function withAppServer<T>(
  options: Omit<OpenAppServerOptions, 'onNotification' | 'onRequest' | 'onExit'>,
  fn: (session: AppServerSession) => Promise<T>,
): Promise<T> {
  const session = await openAppServer(options);
  try {
    return await withTimeout(fn(session), PROBE_TIMEOUT_MS, 'The Codex app server did not answer.');
  } finally {
    await session.process.dispose();
  }
}

/**
 * Turn a failed launch into something a user can act on.
 *
 * `spawn` reports `ENOENT` for a missing executable and for a missing working
 * directory alike, and Codex's own refusal to start on a non-existent
 * `CODEX_HOME` arrives on stderr rather than as an exit code worth reading. The
 * underlying error is wrapped, never swallowed: if the diagnosis is wrong, the
 * original message is the only way anyone will find out.
 */
function enrichLaunchFailure(error: unknown, stderr: string, executable: string): Error {
  const base = error instanceof Error ? error.message : String(error);

  if (/CODEX_HOME points to/i.test(stderr)) {
    return new Error(
      `This profile's Codex directory does not exist, so the CLI refused to start. Create it, or point the profile somewhere else. Codex reported: ${firstLine(stderr)}`,
    );
  }

  if (/ENOENT|not found|not recognized/i.test(base)) {
    return new Error(
      `The "${executable}" CLI could not be started. Check that it is installed and on your PATH. (${base})`,
    );
  }

  return new Error(stderr === '' ? base : `${base} ${firstLine(stderr)}`);
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/** One outstanding approval, keyed by the id the UI answers with. */
interface PendingApproval {
  readonly deferred: Deferred<JsonValue>;
  /** Which server request this was, so the answer uses the right vocabulary. */
  readonly method: string;
  readonly toolName: string;
}

/**
 * One Codex run: a process, a thread, and one turn on it.
 *
 * A run is one turn cycle, per the seam's definition. The thread outlives it —
 * that is what `resumeSessionId` is for — but the process does not.
 */
class CodexRun implements Run {
  readonly runId: string;
  readonly providerId = CODEX_PROVIDER_ID;
  readonly capabilities = CODEX_CAPABILITIES;

  readonly #input: ResolvedRunInput;
  readonly #deps: CodexRunDeps;
  readonly #state: CodexMapperState;
  readonly #eventQueue: AsyncQueue<AgentEvent>;
  readonly #pending = new Map<PermissionRequestId, PendingApproval>();

  #session: AppServerSession | undefined;
  #bootstrap: Promise<void> = Promise.resolve();
  #disposing: Promise<void> | undefined;
  /** Where this run's attachments live, and how many it has written. */
  readonly #stagingDir: string;
  #stagedCount = 0;
  #approvalCounter = 0;
  #detachAbortSignal: (() => void) | undefined;
  #startedAt = 0;

  constructor(input: ResolvedRunInput, deps: CodexRunDeps, stagingDir: string) {
    this.#input = input;
    this.#deps = deps;
    this.runId = input.runId;
    this.#stagingDir = stagingDir;

    this.#state = createCodexMapperState(input.runId, {
      now: deps.now,
      ...(input.resumeSessionId === undefined ? {} : { resumedFrom: input.resumeSessionId }),
      forked: input.forkSession === true,
    });

    this.#eventQueue = new AsyncQueue<AgentEvent>({
      onAbandoned: () => {
        this.#deps.diagnostic?.(`Run ${this.runId}: event stream abandoned by its consumer.`);
      },
    });
  }

  /**
   * Begin the run.
   *
   * Synchronous by design, so the run object is fully constructed before
   * `createRun` returns and a caller can subscribe to `events` before anything
   * is emitted. The connection work is asynchronous and runs as a tracked
   * promise; the event queue buffers, so a consumer cannot tell the difference.
   */
  start(): void {
    this.#startedAt = this.#deps.now();

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

    this.#bootstrap = this.#connect();
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
   * Steer the turn already in flight.
   *
   * Unlike the Claude adapter — which can only queue text and report
   * `deliveredImmediately: false`, because the CLI decides at a tool boundary
   * whether to fold it in — `turn/steer` is acknowledged or rejected by the
   * server. A resolved steer really did land in the running turn, so `true` here
   * is a fact rather than a hope.
   *
   * `expectedTurnId` is what makes that true: the server refuses a steer naming
   * a turn that is no longer live, rather than silently applying it to the next
   * one.
   */
  async send(text: string, attachments?: readonly Attachment[]): Promise<SendResult> {
    if (this.#state.ended) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} has already ended; start a new run with resumeSessionId to continue.`,
      );
    }
    if (this.#disposing !== undefined) {
      throw adapterError(
        'invalid_request',
        `Run ${this.runId} is shutting down and cannot accept more input.`,
      );
    }

    // The turn id arrives on `turn/started`, which can trail the `turn/start`
    // response. Waiting on the bootstrap is what makes an immediate send work.
    await this.#bootstrap;

    const session = this.#session;
    const threadId = this.#state.sessionId;
    const turnId = this.#state.turnId;
    if (session === undefined || threadId === undefined || turnId === undefined) {
      throw adapterError('invalid_request', `Run ${this.runId} has no live turn to steer.`);
    }

    // Staged before the request and outside its `try`, so a staging failure
    // surfaces as itself rather than as "could not steer the Codex turn".
    const { items, note } = await this.#turnInputs(attachments);

    try {
      await session.request(
        CODEX_METHOD.turnSteer,
        wireParams({
          threadId,
          expectedTurnId: turnId,
          input: [...items, textInput(withAttachmentNote(text, note))],
        }),
      );
      return { deliveredImmediately: true };
    } catch (error) {
      throw adapterError('transport', `Could not steer the Codex turn: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  async interrupt(): Promise<InterruptResult> {
    // "Stop" is idempotent by nature; a run that already stopped is not an error.
    if (this.#state.ended) return { stillQueued: [] };

    this.#state.interruptRequested = true;

    const session = this.#session;
    const threadId = this.#state.sessionId;
    if (session === undefined || threadId === undefined) {
      await this.dispose();
      return { stillQueued: [] };
    }

    // An interrupt with prompts still open would deadlock: the turn cannot wind
    // down while it is parked waiting for an answer nobody is going to give.
    this.#denyAllPending();

    try {
      await withTimeout(
        session.request(CODEX_METHOD.turnInterrupt, { threadId }),
        INTERRUPT_TIMEOUT_MS,
        'The Codex app server did not acknowledge the interrupt.',
      );
      // The run does not end here: the server still emits `turn/completed` with
      // `status: "interrupted"`, and that is what produces `run.end`.
      return { stillQueued: [] };
    } catch (error) {
      // Do not leave the user holding a Stop button that did nothing.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: interrupt did not complete, forcing teardown.`,
        describe(error),
      );
      await this.dispose();
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

    entry.deferred.resolve(toApprovalResponse(entry.method, decision));
  }

  dispose(): Promise<void> {
    this.#disposing ??= this.#teardown();
    return this.#disposing;
  }

  /* -------------------------------- internals ------------------------------ */

  /**
   * Write a turn's attachments to disk and say what the turn should carry.
   *
   * ## Everything is staged, images included
   *
   * Codex has no content-block equivalent for either kind. An image goes on the
   * wire as `localImage` — a **path** — and there is no document variant at all,
   * so a PDF or a CSV can only reach the agent as a file it opens itself. Both
   * therefore get written; what differs is what comes back:
   *
   *  - images become `localImage` input items, so the model sees them;
   *  - files become a line in the prompt naming their path, so the agent can
   *    read them. See `describeStagedAttachments`.
   *
   * Artemis holds bytes rather than paths for both — a pasted screenshot never
   * had a path, and see the note atop `protocol/attachment.ts` for why a
   * renderer-supplied path is not something to read on request.
   *
   * ## Why deleting them at dispose is safe
   *
   * An image is read once, at submission: Codex encodes it into a
   * `data:image/…;base64,…` URL, and it is *that* — not the path — which lands
   * in the rollout as the turn's `input_image` content, so a resumed thread
   * still has the picture after the file is gone. (Confirmed against the app
   * server's generated bindings rather than inferred from the docs.)
   *
   * A staged **file** is different and worth being straight about: it is read
   * only if the agent chooses to, and a resumed thread that reaches for one
   * after dispose gets "no such file". That is the honest outcome — the file
   * belonged to a conversation that has ended — and it beats leaving a
   * directory per run on disk forever.
   */
  async #turnInputs(
    attachments: readonly Attachment[] | undefined,
  ): Promise<{ readonly items: readonly CodexUserInput[]; readonly note: string }> {
    const all = attachments ?? [];
    if (all.length === 0) return { items: [], note: '' };

    const staged = await stageAttachments(this.#stagingDir, all, this.#stagedCount);
    this.#stagedCount += all.length;

    const items = staged
      .filter(({ attachment }) => isImageAttachment(attachment))
      .map(({ path }): CodexUserInput => ({ type: 'localImage', path }));

    // Only the files get named. An image is already an input item; pointing the
    // agent at a staged copy would invite a tool call to open a picture the
    // model can already see.
    const note = describeStagedAttachments(
      staged.filter(({ attachment }) => isFileAttachment(attachment)),
    );

    return { items, note };
  }

  async #connect(): Promise<void> {
    let session: AppServerSession;
    try {
      session = await openAppServer({
        deps: this.#deps,
        env: this.#input.env,
        cwd: this.#input.cwd,
        ...(this.#input.inheritHostEnv === undefined
          ? {}
          : { inheritHostEnv: this.#input.inheritHostEnv }),
        onNotification: (method, params) => {
          this.#onNotification(method, params);
        },
        onRequest: (request) => this.#onServerRequest(request),
        onExit: (reason) => {
          this.#onProcessExit(reason);
        },
      });
    } catch (error) {
      this.#failToLaunch(error);
      return;
    }

    this.#session = session;

    // A dispose that landed while the handshake was in flight has already run
    // its teardown against a session that did not exist yet.
    if (this.#disposing !== undefined || this.#state.ended) {
      await session.process.dispose();
      return;
    }

    try {
      const threadId = await this.#openThread(session);
      await this.#startTurn(session, threadId);
    } catch (error) {
      this.#fail(toAgentError(error, 'transport'));
    }
  }

  /** Start a new thread, resume one, or fork one, per the run's input. */
  async #openThread(session: AppServerSession): Promise<string> {
    const resume = this.#input.resumeSessionId;

    if (resume === undefined) {
      const response = await session.request(CODEX_METHOD.threadStart, { cwd: this.#input.cwd });
      return requireThreadId(response);
    }

    if (this.#input.forkSession === true) {
      const response = await session.request(CODEX_METHOD.threadFork, {
        threadId: resume,
        cwd: this.#input.cwd,
      });
      return requireThreadId(response);
    }

    const response = await session.request(CODEX_METHOD.threadResume, {
      threadId: resume,
      cwd: this.#input.cwd,
    });
    return requireThreadId(response);
  }

  async #startTurn(session: AppServerSession, threadId: string): Promise<void> {
    const permissions = toCodexPermissions(this.#input.permissionMode, {
      cwd: this.#input.cwd,
      ...(this.#input.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: this.#input.additionalDirectories }),
    });

    if (this.#input.model !== undefined) this.#state.model = this.#input.model;

    // Images before the text, matching the Claude adapter and Codex's own
    // client: a question asked before its screenshot is answered worse.
    const { items, note } = await this.#turnInputs(this.#input.attachments);

    const response = await session.request(
      CODEX_METHOD.turnStart,
      wireParams({
        threadId,
        input: [...items, textInput(withAttachmentNote(this.#input.prompt, note))],
        cwd: this.#input.cwd,
        approvalPolicy: permissions.approvalPolicy,
        sandboxPolicy: permissions.sandboxPolicy,
        ...(this.#input.model === undefined ? {} : { model: this.#input.model }),
        ...(this.#input.effort === undefined
          ? {}
          : { effort: this.#input.effort as CodexReasoningEffort }),
      }),
    );

    // `turn/started` normally supplies this, but the response carries it too and
    // arrives first often enough to matter for an immediate `send()`.
    const turnId = readString(asRecord(asRecord(response)['turn']), 'id');
    if (turnId !== undefined) this.#state.turnId ??= turnId;
  }

  #onNotification(method: string, params: JsonValue | undefined): void {
    let events: readonly AgentEvent[] = [];
    try {
      events = mapCodexNotification(method, params, this.#state);
    } catch (error) {
      // A mapping bug must degrade to a missing event, never to a dead
      // transcript. The run keeps going.
      this.#deps.diagnostic?.(
        `Run ${this.runId}: failed to map the "${method}" notification.`,
        describe(error),
      );
      return;
    }
    for (const event of events) this.#emit(event);
  }

  /**
   * Turn a server-initiated approval request into a `permission.request`.
   *
   * The returned promise is what parks the provider: it is handed straight back
   * to the JSON-RPC layer, which does not answer the request until it settles.
   * There is no deadline, by design — an unanswered prompt parks the run until
   * the user decides, is interrupted, or is disposed. Both of the latter settle
   * every outstanding deferred, so the provider is never left waiting on a
   * promise nobody will resolve.
   */
  async #onServerRequest(request: IncomingRequest): Promise<JsonValue> {
    const kind = approvalKind(request.method);
    if (kind === undefined) {
      // Not an approval — a dynamic tool call, an MCP elicitation, something
      // newer. Declining is the only safe answer: Artemis has no UI for it, and
      // parking would hang the turn forever.
      this.#deps.diagnostic?.(`Run ${this.runId}: declining unsupported request "${request.method}".`);
      return { decision: 'decline' };
    }

    if (this.#state.ended || this.#disposing !== undefined) {
      return { decision: 'decline' };
    }

    this.#approvalCounter += 1;
    const requestId: PermissionRequestId = `${this.runId}:perm:${String(this.#approvalCounter)}`;
    const deferred = createDeferred<JsonValue>();

    const params = asRecord(request.params);
    const permissionRequest = toPermissionRequest(requestId, this.runId, kind, params, this.#deps.now());

    this.#pending.set(requestId, {
      deferred,
      method: request.method,
      toolName: permissionRequest.toolName,
    });

    this.#emit({
      type: 'permission.request',
      ...nextCodexEventEnvelope(this.#state),
      requestId,
      request: permissionRequest,
    });

    return deferred.promise;
  }

  /**
   * The process died.
   *
   * Distinguishes a death we caused from one we did not: during dispose the
   * teardown path owns the terminal event, so this must not race it.
   */
  #onProcessExit(reason: string): void {
    if (this.#state.ended || this.#disposing !== undefined) return;
    this.#fail({ code: 'transport', message: reason, retryable: false });
  }

  #failToLaunch(error: unknown): void {
    this.#fail(toAgentError(error, 'provider_not_found'));
  }

  /** End the run with an error, honouring the reason precedence rules. */
  #fail(error: AgentError): void {
    if (this.#state.ended) return;
    this.#denyAllPending();
    for (const event of finalizeCodexRun(this.#state, 'error', { error })) this.#emit(event);
    this.#eventQueue.close();
  }

  async #teardown(): Promise<void> {
    this.#state.disposeRequested = true;
    this.#detachAbortSignal?.();

    // 1. Unblock the provider first. A parked approval holds the turn open, and
    //    the app server will not shut down while it is waiting on one.
    this.#denyAllPending();

    // 2. Let the bootstrap finish so it cannot resurrect a session underneath
    //    the teardown. It swallows its own errors, so this cannot reject.
    await settleWithin(this.#bootstrap, DISPOSE_GRACE_MS);

    // 3. Ask the turn to stop, so the server can flush a clean `turn/completed`
    //    rather than being killed mid-write.
    const session = this.#session;
    const threadId = this.#state.sessionId;
    if (session !== undefined && threadId !== undefined && !this.#state.ended) {
      try {
        await withTimeout(
          session.request(CODEX_METHOD.turnInterrupt, { threadId }),
          INTERRUPT_TIMEOUT_MS,
          'interrupt timed out',
        );
      } catch {
        // Best effort. The process is coming down either way.
      }
    }

    // 4. Take the process down.
    if (session !== undefined) await session.process.dispose(DISPOSE_GRACE_MS);

    // 5. Drop the staged attachments, now that the process that read them is
    //    gone. After the process, so a turn still winding down cannot lose a
    //    file out from under itself; best-effort, because a temp directory that
    //    outlives its run is a smaller problem than a dispose that throws.
    await removeStagingDirectory(this.#stagingDir, (message) => {
      this.#deps.diagnostic?.(`Run ${this.runId}: ${message}`);
    });

    // 6. Guarantee the contract even if the server never came back at all:
    //    every open tool call closed, exactly one `run.end`, stream terminated.
    for (const event of flushCodexToolCalls(this.#state)) this.#emit(event);
    for (const event of finalizeCodexRun(this.#state, 'disposed')) this.#emit(event);
    this.#eventQueue.close();
    this.#denyAllPending();
  }

  /**
   * Settle every outstanding approval as a denial.
   *
   * Called from teardown, interrupt and failure. Idempotent by construction —
   * `Deferred` settles once — so overlapping paths are harmless.
   */
  #denyAllPending(): void {
    if (this.#pending.size === 0) return;
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, entry] of entries) {
      entry.deferred.resolve(toApprovalResponse(entry.method, { behavior: 'deny' }));
    }
  }

  #emit(event: AgentEvent): void {
    if (this.#eventQueue.closed) return;
    this.#eventQueue.push(event);
    // Nothing follows `run.end`: the stream terminates with it, which is what
    // lets a consumer's `for await` finish on its own.
    if (event.type === 'run.end') this.#eventQueue.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

type ApprovalKind = 'command' | 'fileChange' | 'permissions';

function approvalKind(method: string): ApprovalKind | undefined {
  switch (method) {
    case CODEX_SERVER_REQUEST.commandExecutionApproval:
      return 'command';
    case CODEX_SERVER_REQUEST.fileChangeApproval:
      return 'fileChange';
    case CODEX_SERVER_REQUEST.permissionsApproval:
      return 'permissions';
    default:
      return undefined;
  }
}

/** Build the prompt the UI renders, in the vocabulary of whichever request arrived. */
function toPermissionRequest(
  id: PermissionRequestId,
  runId: string,
  kind: ApprovalKind,
  params: Record<string, unknown>,
  requestedAt: number,
): PermissionRequest {
  const reason = readString(params, 'reason');
  const itemId = readString(params, 'itemId');

  const common = {
    id,
    runId,
    requestedAt,
    ...(itemId === undefined ? {} : { toolCallId: itemId as PermissionRequest['toolCallId'] }),
    ...(reason === undefined ? {} : { reason }),
  };

  if (kind === 'command') {
    const command = readString(params, 'command') ?? '';
    const cwd = readString(params, 'cwd');
    return {
      ...common,
      toolName: 'Shell',
      input: { command, ...(cwd === undefined ? {} : { cwd }) },
      displayName: 'Run command',
      title: command === '' ? 'Codex wants to run a command' : `Codex wants to run: ${command}`,
      ...(cwd === undefined ? {} : { description: `Working directory: ${cwd}` }),
    };
  }

  if (kind === 'fileChange') {
    const grantRoot = readString(params, 'grantRoot');
    return {
      ...common,
      toolName: 'ApplyPatch',
      input: grantRoot === undefined ? {} : { grantRoot },
      displayName: 'Edit files',
      title:
        grantRoot === undefined
          ? 'Codex wants to change files'
          : `Codex wants to write under ${grantRoot}`,
      ...(grantRoot === undefined ? {} : { blockedPath: grantRoot }),
    };
  }

  const permissions = params['permissions'];
  return {
    ...common,
    toolName: 'Permissions',
    input: (typeof permissions === 'object' && permissions !== null && !Array.isArray(permissions)
      ? (permissions as JsonObject)
      : {}),
    displayName: 'Grant access',
    title: 'Codex is requesting additional access',
  };
}

/**
 * Translate one Artemis decision into the vocabulary of one server request.
 *
 * The three approval requests take three *different* decision types on the
 * wire. They happen to share the `accept` / `acceptForSession` / `decline` /
 * `cancel` spelling, but command execution also accepts two structured
 * variants, and the permissions request answers with a granted subset plus a
 * scope instead of a bare decision. Assuming one shape fits all is the kind of
 * thing that works right up until the day it silently grants more than the user
 * clicked.
 *
 * `scope: 'session'` is the mapping for Artemis's `scope: 'session'` — the
 * "always allow" affordance. Anything else stays scoped to this one call.
 */
export function toApprovalResponse(method: string, decision: PermissionDecision): JsonValue {
  const persist =
    decision.behavior === 'allow' &&
    (decision.scope === 'session' || (decision.updatedPermissions?.length ?? 0) > 0);

  if (method === CODEX_SERVER_REQUEST.permissionsApproval) {
    // A denial grants the empty set rather than refusing to answer: the tool
    // asked which permissions it may have, and "none" is a valid answer.
    return decision.behavior === 'allow'
      ? { permissions: [], scope: persist ? 'session' : 'turn' }
      : { permissions: [] };
  }

  if (decision.behavior === 'deny') return { decision: 'decline' };
  return { decision: persist ? 'acceptForSession' : 'accept' };
}

/* -------------------------------------------------------------------------- */
/* Response parsing                                                           */
/* -------------------------------------------------------------------------- */

function requireThreadId(response: JsonValue): string {
  const thread = asRecord(asRecord(response)['thread']);
  const id = readString(thread, 'id') ?? readString(asRecord(response), 'threadId');
  if (id === undefined) {
    throw adapterError('transport', 'Codex did not return a thread id.');
  }
  return id;
}

/** Read `model/list` into picker options, dropping models Codex marks hidden. */
export function parseModelList(response: JsonValue): readonly ProviderModelOption[] {
  const data = asRecord(response)['data'];
  if (!Array.isArray(data)) return [];

  const models: ProviderModelOption[] = [];
  for (const raw of data) {
    const entry = asRecord(raw);
    if (entry['hidden'] === true) continue;

    const id = readString(entry, 'id') ?? readString(entry, 'model');
    if (id === undefined) continue;

    const displayName = readString(entry, 'displayName');
    const efforts = Array.isArray(entry['supportedReasoningEfforts'])
      ? (entry['supportedReasoningEfforts'] as unknown[])
          .map((level) => readString(asRecord(level), 'reasoningEffort'))
          .filter((level): level is string => level !== undefined && EFFORT_IDS.has(level))
      : undefined;

    const option: ProviderModelOption = {
      id,
      label: displayName ?? id,
      ...(displayName === undefined ? {} : { displayName }),
      note: readString(entry, 'description') ?? '',
      ...(efforts === undefined || efforts.length === 0 ? {} : { effortLevels: efforts }),
    };

    // The provider's own default leads the list — `ProviderDescriptor.models`
    // documents the first entry as what a run gets when `model` is omitted, so
    // ordering here is a contract rather than a presentation choice.
    if (entry['isDefault'] === true) models.unshift(option);
    else models.push(option);
  }

  return models;
}

/** Read `thread/list` into session summaries. */
export function parseThreadList(
  response: JsonValue,
  profileId: SessionSummary['profileId'],
  fallbackCwd: string | undefined,
): SessionSummary[] {
  const data = asRecord(response)['data'];
  if (!Array.isArray(data)) return [];

  const sessions: SessionSummary[] = [];
  for (const raw of data) {
    const thread = asRecord(raw);
    const id = readString(thread, 'id');
    if (id === undefined) continue;

    // `cwd` comes from the thread record, never from the storage path — the
    // obligation `ProviderAdapter.listAllSessions` documents. A thread with no
    // recoverable directory cannot be grouped or resumed, so it is dropped
    // rather than guessed at.
    const cwd = readString(thread, 'cwd') ?? fallbackCwd;
    if (cwd === undefined) continue;

    const name = readString(thread, 'name');
    const preview = readString(thread, 'preview');

    // Codex timestamps threads in Unix *seconds*; every Artemis timestamp is
    // milliseconds.
    const createdAt = readNumber(thread, 'createdAt');
    const updatedAt = readNumber(thread, 'updatedAt') ?? createdAt ?? 0;

    sessions.push({
      id: id as SessionId,
      providerId: CODEX_PROVIDER_ID,
      profileId,
      cwd,
      title: name ?? preview ?? 'Untitled session',
      ...(name === undefined ? {} : { titleIsCustom: true }),
      ...(preview === undefined ? {} : { firstPrompt: preview }),
      updatedAt: updatedAt * 1000,
      ...(createdAt === undefined ? {} : { createdAt: createdAt * 1000 }),
    });
  }

  return sessions;
}

/**
 * Read the rate-limit windows.
 *
 * Codex reports up to two anonymous windows described by their duration rather
 * than by a name, so the label is derived from `windowDurationMins` — 43200
 * minutes is the monthly window a free plan reported during testing. The window
 * ids are Artemis's own vocabulary; `PlanUsageWindowId` is deliberately
 * open-ended so a provider can contribute its own.
 */
export function parseRateLimitWindows(limits: Record<string, unknown>): PlanUsageWindow[] {
  const windows: PlanUsageWindow[] = [];

  for (const [key, id] of [
    ['primary', 'primary'],
    ['secondary', 'secondary'],
  ] as const) {
    const raw = asRecord(limits[key]);
    if (Object.keys(raw).length === 0) continue;

    const usedPercent = readNumber(raw, 'usedPercent');
    const durationMins = readNumber(raw, 'windowDurationMins');
    const resetsAt = readNumber(raw, 'resetsAt');

    windows.push({
      id,
      label: durationLabel(durationMins),
      utilization: usedPercent ?? null,
      // Unix seconds here, unlike the `*AtMs` fields elsewhere in the protocol.
      resetsAt: resetsAt === undefined ? null : resetsAt * 1000,
    });
  }

  return windows;
}

function durationLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'Plan limit';
  if (minutes % (60 * 24 * 30) === 0) {
    const months = minutes / (60 * 24 * 30);
    return months === 1 ? '30 days' : `${String(months * 30)} days`;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? '24 hours' : `${String(days)} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  }
  return `${String(minutes)} minutes`;
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

/** What the app server says about a config directory's credential. */
export interface CodexAuthStatus {
  readonly loggedIn: boolean;
  /** `chatgpt` for a subscription, `apikey` for metered billing. */
  readonly authMethod?: string;
  readonly error?: string;
}

/**
 * Ask the app server whether this profile is signed in.
 *
 * The structured alternative to `codex login status`, which prints prose — see
 * the note on {@link CODEX_CREDENTIALS}. Never throws: every caller is UI that
 * has to render something either way.
 */
export async function checkCodexAuth(options: {
  readonly env: EnvBundle;
  readonly cwd: string;
  readonly deps: CodexRunDeps;
}): Promise<CodexAuthStatus> {
  try {
    const response = await withAppServer(
      { deps: options.deps, env: options.env, cwd: options.cwd },
      async (session) => session.request(CODEX_METHOD.getAuthStatus, {}),
    );
    const status = asRecord(response);
    const authMethod = readString(status, 'authMethod');
    return {
      loggedIn: authMethod !== undefined,
      ...(authMethod === undefined ? {} : { authMethod }),
    };
  } catch (error) {
    return { loggedIn: false, error: describe(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Wrap a string as the one input shape `turn/start` and `turn/steer` accept. */
function textInput(text: string): CodexTextInput {
  // `text_elements` is required and snake_case; omitting it fails the request
  // with an error naming `type`. See the note on `CodexTextInput`.
  return { type: 'text', text, text_elements: [] };
}

/**
 * Hand a typed params object to the wire.
 *
 * `JsonValue` is defined with a `readonly [key: string]: JsonValue` index
 * signature, and a declared `interface` never satisfies one structurally —
 * TypeScript cannot prove a named type has no extra non-JSON members. Every
 * params type in `codexProtocol.ts` is JSON by construction, so the cast is
 * safe; it lives here, named and explained, rather than being sprinkled as
 * `as unknown as JsonValue` at each call site.
 */
function wireParams(value: object): JsonValue {
  return value as unknown as JsonValue;
}

/** Read `codex --version`, or `undefined` when the binary is not there. */
async function readCodexVersion(
  executable: string,
  hostEnv: EnvBundle | undefined,
): Promise<string | undefined> {
  const { spawn } = await import('node:child_process');

  return new Promise<string | undefined>((resolve) => {
    const child = spawn(executable, ['--version'], {
      env: composeProviderEnv({}, {
        ...(hostEnv === undefined ? {} : { hostEnv }),
        scrubKeys: CODEX_CREDENTIAL_ENVS,
      }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined);
    });
  });
}

function byNewestThenId(a: SessionSummary, b: SessionSummary): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id.localeCompare(b.id);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(adapterError('transport', message));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Await a promise, but give up waiting after `ms`. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
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

function describe(error: unknown): string {
  if (error instanceof JsonRpcError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
