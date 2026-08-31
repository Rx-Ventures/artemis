/**
 * Driving a provider's login from the server, for a person who is elsewhere.
 * ============================================================================
 *
 * `adapters/signIn.ts` states the rule this file works under and does not
 * break: **Artemis performs no login.** It spawns the provider's CLI, points
 * one environment variable at a config directory, and reads a boolean back. No
 * token is parsed, stored, forwarded or logged here either — the CLI writes its
 * own credential into its own directory, exactly as it does when a person runs
 * it in a terminal.
 *
 * What is different is who is watching. That file explains why the *desktop*
 * hands the user a command to run rather than spawning it, and the reasoning is
 * sound for a login on the machine the user is sitting at. It does not carry to
 * a server in a container, where there is no terminal to hand the command to —
 * and where the three failures it names do not happen:
 *
 *  - **"Unobservable."** It is observed. Stdout is read incrementally and the
 *    verification URL is published the moment it appears; the client polls a
 *    state machine rather than a spinner, and every terminal state says which
 *    one it is.
 *  - **"An interactive prompt hangs it."** The prompt is the point. Stdin is a
 *    pipe, not `'ignore'`, and the one question the CLI asks — paste the code —
 *    is answered by the person the flow was started for.
 *  - **"Nothing to retry, nothing to read."** There is a cancel, a hard
 *    timeout, an error string on the terminal state, and the config directory
 *    is still there to be signed into by hand if all of it fails.
 *
 * So the position is not reversed, it is scoped: a *local* sign-in stays
 * copy-a-command, because the user has a terminal and a command they can re-run
 * beats a subprocess they cannot see. A *server-hosted, client-attended*
 * sign-in drives the subprocess, because the alternative is no sign-in at all.
 *
 * ---------------------------------------------------------------------------
 * ONE AT A TIME
 * ---------------------------------------------------------------------------
 *
 * A server runs at most one of these. Not because two would race — they would
 * write to different directories — but because each one is a subprocess parked
 * on a human, and a surface that lets a caller start them without bound is a
 * surface that lets a caller park processes without bound. The second attempt
 * is refused while the first is live, and the refusal names the account that
 * has the floor.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HARD TIMEOUT IS FOR
 * ---------------------------------------------------------------------------
 *
 * A sign-in nobody finishes is a subprocess nobody kills. Ten minutes is
 * generous for "open a link, sign in, paste a code" and short enough that a
 * browser tab abandoned at lunch does not hold the floor until the container
 * restarts. When it fires, the subprocess is killed and the state is `expired`
 * — a distinct answer from `failed`, because nothing went wrong except time.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import type {
  ProfileId,
  ServerSignInAccount,
  ServerSignInState,
  ServerSignInStatus,
} from '@rx-artemis/protocol';
import { isSignInSettled } from '@rx-artemis/protocol';

import { checkAuthStatus } from '../adapters/signIn.js';
import { scrubSecrets } from '../adapters/types.js';
import type { AuthStatus, ProviderCredentialSpec } from '../adapters/types.js';

/** Ten minutes. See the file comment. */
export const DEFAULT_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * How much of one login's output is kept.
 *
 * The only thing an authenticated caller can make this server allocate on this
 * path, and a login has never had more than a few hundred bytes to say. See
 * `read`, which discards the *tail* past this rather than the head.
 */
const MAX_SIGN_IN_OUTPUT = 256 * 1024;

/**
 * One account this server can drive a login for.
 *
 * The seam between the router and whatever holds the profiles — the headless
 * host's `ProfileStore` in the deployment that has one, a fake in a test.
 * Everything the sign-in needs to spawn a CLI is here, so nothing under
 * `server/` reaches into the store directly.
 */
export interface ServerProfileRecord {
  readonly id: ProfileId;
  readonly label: string;
  readonly providerId: string;
  /** Absolute, on the serving machine. What scopes the login. */
  readonly configDir: string;
  /** The provider's own vocabulary: which binary, which argv, which variable. */
  readonly credentials: ProviderCredentialSpec;
}

/**
 * Creating, finding, and now managing serving accounts, as the admin routes
 * need them.
 *
 * `delete` was deliberately withheld until a UI existed that makes the
 * consequence plain; the server card has one now — the confirmation names
 * what goes (the account and its routes) and what stays (the directory on the
 * serving machine). `update` is what account parity is built from: the same
 * label / address / key trio a local profile's editor writes, minus the
 * fields that only make sense on the machine the store lives on.
 */
export interface ProfileAdmin {
  /**
   * Register an account and make its config directory.
   *
   * The API twin of `artemis-server profile add`, and the implementation
   * *behind* that verb as well, so the two cannot drift. Rejects a duplicate
   * label by throwing {@link DuplicateProfileLabelError}, because a label is
   * what a route's slug is derived from and two accounts called "work" produce
   * `work` and `work-2` — an address that silently moves when either is
   * renamed.
   *
   * `configDir` is for the CLI alone. A caller over the wire has no way to know
   * what is a sensible path *inside the container*, so the HTTP route never
   * sends one and the store's own suggestion stands.
   */
  create(draft: {
    readonly label: string;
    readonly providerId: string;
    readonly configDir?: string;
  }): Promise<ServerProfileRecord>;
  /** One account, or `undefined`. */
  find(profileId: string): Promise<ServerProfileRecord | undefined>;
  /**
   * Change an account: label, endpoint address, key — any subset.
   *
   * The same semantics the local profile editor gets from `ProfilePatch`:
   * omitted leaves a field alone, the empty string clears `baseUrl` and
   * `apiKey`. A rename re-derives the account's route slug, so the reply
   * carries the whole record — the caller's address for this account may
   * just have moved. Rejects a duplicate label with
   * {@link DuplicateProfileLabelError} exactly as `create` does, and for the
   * same reason.
   */
  update(
    profileId: string,
    patch: {
      readonly label?: string;
      readonly baseUrl?: string;
      readonly apiKey?: string;
    },
  ): Promise<ServerProfileRecord>;
  /**
   * Remove an account: the record, its key, its routes.
   *
   * The config directory stays on disk — a wire caller cannot judge what a
   * path on the serving machine holds, and a credential left in a directory
   * is recoverable where a deleted one is not. The server CLI keeps the
   * full-removal verb.
   */
  delete(profileId: string): Promise<void>;
}

/** Thrown by {@link ProfileAdmin.create} when the label is taken. */
export class DuplicateProfileLabelError extends Error {
  constructor(label: string) {
    super(`An account called "${label}" already exists on this server.`);
    this.name = 'DuplicateProfileLabelError';
  }
}

/** Thrown by {@link SignInDirector.start} when another sign-in has the floor. */
export class SignInBusyError extends Error {
  /** The account that holds it, so the refusal can name something. */
  readonly holder: string;

  constructor(holder: string) {
    super(`A sign-in is already in progress for "${holder}". Finish or cancel it first.`);
    this.name = 'SignInBusyError';
    this.holder = holder;
  }
}

/** Thrown when the provider's CLI is not installed where the server can run it. */
export class SignInUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInUnavailableError';
  }
}

/** Thrown by {@link SignInDirector.submitCode} against a flow that cannot take one. */
export class SignInNotWaitingError extends Error {
  constructor(state: ServerSignInState) {
    super(
      isSignInSettled(state)
        ? `This sign-in has already ${state === 'done' ? 'finished' : state}. Start another one.`
        : 'This sign-in is not waiting for a code yet.',
    );
    this.name = 'SignInNotWaitingError';
  }
}

export interface SignInDirectorOptions {
  /** How long an unfinished sign-in lives. Defaults to {@link DEFAULT_SIGN_IN_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * The environment the CLI inherits. Defaults to this process's.
   *
   * Named rather than assumed because `PATH` decides whether the binary
   * resolves at all, and a test that could not control it would have to install
   * a CLI to run.
   */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Injected by tests. Defaults to `node:child_process`'s. */
  readonly spawn?: typeof spawn;
  /**
   * Ask the account whether it is now signed in. Defaults to
   * {@link checkAuthStatus}, which is the same probe the profile screen polls.
   */
  readonly checkStatus?: (input: {
    readonly credentials: ProviderCredentialSpec;
    readonly configDir: string;
    readonly hostEnv?: NodeJS.ProcessEnv;
  }) => Promise<AuthStatus>;
  /** Injected so a test can move time without waiting for it. */
  readonly now?: () => number;
}

export interface SignInDirector {
  /**
   * Spawn the provider's login for one account.
   *
   * @throws {SignInBusyError} another sign-in is live.
   * @throws {SignInUnavailableError} the CLI is not on this machine, or the
   *   provider has no login to drive.
   */
  start(profile: ServerProfileRecord): ServerSignInStatus;
  /**
   * The flow for this account, or `undefined` when there is none.
   *
   * A settled flow is kept until another starts, which is what lets a client
   * that polled a moment too late still read `done` rather than a 404 it would
   * have to interpret.
   */
  status(profileId: string): ServerSignInStatus | undefined;
  /** Write the user's code to the subprocess's stdin. */
  submitCode(profileId: string, code: string): ServerSignInStatus;
  /** Kill the subprocess. Idempotent. */
  cancel(profileId: string): ServerSignInStatus | undefined;
  /** Stop everything. Called from the server's own `close`. */
  close(): void;
}

/* -------------------------------------------------------------------------- */
/* Reading the CLI's output                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Strip ANSI escapes before anything tries to read the text.
 *
 * A CLI that has decided it is talking to a terminal colours its prompt and
 * underlines its URL, and the escape bytes land in the middle of the token a
 * URL matcher is looking for. This is also what stops a control sequence
 * reaching a client that will render the string.
 */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- the point is the control bytes
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\][^]*/g, '');
}

/**
 * The first address in the CLI's output that a user could sign in at.
 *
 * Deliberately the first rather than the longest or the last: a login prints
 * its verification URL before anything else, and later ones are documentation
 * links and update notices. Trailing punctuation is trimmed because a CLI that
 * writes `Open https://example.com/x.` means the sentence to end, not the URL.
 */
export function findVerificationUrl(output: string): string | undefined {
  const match = /https?:\/\/[^\s"'<>`]+/.exec(plain(output));
  if (match === null) return undefined;
  return match[0].replace(/[.,;:)\]}'"]+$/, '');
}

/**
 * A short confirmation code, when the provider prints one.
 *
 * Two groups of four or more, hyphenated and upper-case — the shape every
 * device flow that shows one uses, and narrow enough that it does not match a
 * word in a sentence. Absent for Claude, whose flow has no such code, which is
 * why callers treat this as optional rather than as part of the contract.
 */
export function findUserCode(output: string): string | undefined {
  const match = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/.exec(plain(output));
  return match?.[1];
}

/**
 * Has the CLI asked for the code yet?
 *
 * A heuristic over the words CLIs actually print, and treated as one
 * everywhere: it upgrades the reported state so a client can say "paste it
 * now", and it gates nothing. {@link SignInDirector.submitCode} accepts a code
 * in `awaiting_browser` too, because a phrase this list has not met would
 * otherwise strand a user holding a correct code.
 */
export function looksLikeCodePrompt(output: string): boolean {
  return /(paste|enter|copy).{0,40}code|code\s*[:>]|authorization code|verification code/i.test(
    plain(output),
  );
}

/**
 * The CLI refused the code and wants another one.
 *
 * This is the case that makes the sign-in state machine bidirectional, and it
 * is the most common thing that actually happens: a code copied one character
 * short. `claude auth login` answers *Invalid code. Please make sure the full
 * code was copied.*, stays alive, and asks again — and a flow that read that as
 * a failure would kill a login the user was one paste away from finishing.
 *
 * Returns the offending line rather than a boolean, because the provider is the
 * only thing that knows *why* — wrong, truncated, expired — and a fixed
 * sentence of our own would throw that away. Scrubbed and capped by the caller.
 */
export function findCodeRejection(output: string): string | undefined {
  const pattern =
    /^.*\b(?:invalid|incorrect|wrong|expired|malformed)\b.{0,40}\bcode\b.*$|^.*\bcode\b.{0,40}\b(?:invalid|incorrect|not recognized|not recognised|expired|did not match|didn't match)\b.*$/im;
  const match = pattern.exec(plain(output));
  return match?.[0].trim().replace(/\s+/g, ' ') || undefined;
}

/* -------------------------------------------------------------------------- */
/* Finding the binary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the provider's executable to something spawnable, or `undefined`.
 *
 * A path with a separator in it is taken as given — that is the packaged
 * Artemis handing over its own bundled binary — and everything else is looked
 * up on `PATH`, which is what the container image relies on. Node's `spawn`
 * would do a lookup of its own, but it does it *inside* the child and reports
 * failure as an `ENOENT` on an event, arriving after a route has already
 * answered 200 and a client is already polling. Resolving first turns that into
 * one sentence at the moment the caller asked.
 *
 * `PATHEXT` is honoured on Windows for the reason `adapters/signIn.ts` explains
 * at length: an npm-installed `claude` is a `claude.cmd`, and a lookup that
 * only tried the bare name would report a perfectly good install as missing.
 */
export function resolveExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const runnable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  };

  const extensions =
    process.platform === 'win32'
      ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)]
      : [''];

  if (executable.includes('/') || executable.includes('\\') || isAbsolute(executable)) {
    return extensions.map((ext) => `${executable}${ext}`).find(runnable);
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const found = extensions.map((ext) => join(dir, `${executable}${ext}`)).find(runnable);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* The director                                                               */
/* -------------------------------------------------------------------------- */

/** One live or recently-settled sign-in. */
interface Flow {
  readonly profileId: ProfileId;
  readonly label: string;
  readonly configDir: string;
  readonly credentials: ProviderCredentialSpec;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly child: ChildProcess | undefined;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  state: ServerSignInState;
  output: string;
  /**
   * How much output had arrived when the last code was written to stdin.
   *
   * Everything before it is the conversation that *asked* for a code; only
   * what comes after it can be an answer about the code that was given. Without
   * the mark, the prompt the CLI printed before the first submission would
   * match the retry heuristic and bounce a perfectly good flow straight back
   * out of `completing`.
   */
  submittedAt: number;
  verificationUrl?: string;
  userCode?: string;
  codeError?: string;
  error?: string;
  account?: ServerSignInAccount;
}

export function createSignInDirector(options: SignInDirectorOptions = {}): SignInDirector {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const spawnProcess = options.spawn ?? spawn;
  const hostEnv = options.hostEnv ?? process.env;
  const probe =
    options.checkStatus ??
    ((input) =>
      checkAuthStatus({
        credentials: input.credentials,
        configDir: input.configDir,
        ...(input.hostEnv === undefined ? {} : { hostEnv: input.hostEnv }),
      }));

  /** At most one, live or settled. See the file comment on why one. */
  let current: Flow | null = null;

  const snapshot = (flow: Flow): ServerSignInStatus => ({
    object: 'artemis.signin',
    profileId: flow.profileId,
    state: flow.state,
    ...(flow.verificationUrl === undefined ? {} : { verificationUrl: flow.verificationUrl }),
    ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
    ...(flow.codeError === undefined ? {} : { codeError: flow.codeError }),
    ...(flow.error === undefined ? {} : { error: flow.error }),
    ...(flow.account === undefined ? {} : { account: flow.account }),
    startedAt: flow.startedAt,
    expiresAt: flow.expiresAt,
  });

  /**
   * Move a live flow to a terminal state and let go of the subprocess.
   *
   * Guarded on `isSignInSettled` rather than on a boolean of its own, so a
   * process that exits a moment after the timeout killed it cannot rewrite
   * `expired` into `failed` — the first answer is the true one, and the second
   * is the consequence.
   */
  const settle = (flow: Flow, state: ServerSignInState, error?: string): void => {
    if (isSignInSettled(flow.state)) return;
    flow.state = state;
    if (error !== undefined) flow.error = error;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    kill(flow.child);
  };

  /**
   * The subprocess, and anything it started.
   *
   * A login CLI is routinely a shim — an npm `.cmd`, a wrapper script — and
   * killing the shim leaves the real process holding the config directory. The
   * process group is killed where the platform has one; on Windows there is no
   * group to signal and `kill()` on the handle is the whole of what is
   * available.
   */
  const kill = (child: ChildProcess | undefined): void => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        process.kill(-child.pid, 'SIGTERM');
        return;
      }
    } catch {
      // No group, or it is already gone. Fall through to the handle.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Already dead. Nothing to do and nothing worth reporting.
    }
  };

  const read = (flow: Flow, chunk: string): void => {
    /*
     * Appended, and capped by *stopping* rather than by dropping the front.
     *
     * The obvious ring buffer — keep the last 64 KiB — is right for reading a
     * URL and wrong for `submittedAt`: dropping bytes off the front moves every
     * offset into this string, and the retry mark would come to point into the
     * middle of a sentence. So the cap discards the tail instead. A login
     * prints a few hundred bytes; a CLI that prints 256 KiB has gone wrong in
     * a way no amount of reading will diagnose, and the timeout is what
     * actually ends it.
     */
    if (flow.output.length < MAX_SIGN_IN_OUTPUT) flow.output += chunk;
    if (isSignInSettled(flow.state)) return;

    /*
     * The one edge that goes backwards. A CLI that will not take the code says
     * so and asks again — see `findCodeRejection` — and only what it printed
     * *after* the code was sent can be about that code.
     */
    if (flow.state === 'completing') {
      const rejection = findCodeRejection(flow.output.slice(flow.submittedAt));
      if (rejection !== undefined) {
        // Scrubbed, because this is provider text on the one path where the
        // user has just typed a secret into the same conversation. The
        // codebase's own backstop, applied at the last moment before the
        // string becomes a reply.
        flow.codeError = scrubSecrets(rejection).slice(0, 300);
        flow.state = 'awaiting_code';
      }
      return;
    }

    if (flow.verificationUrl === undefined) {
      const url = findVerificationUrl(flow.output);
      if (url !== undefined) {
        flow.verificationUrl = url;
        if (flow.state === 'starting') flow.state = 'awaiting_browser';
      }
    }
    if (flow.userCode === undefined) {
      const code = findUserCode(flow.output);
      if (code !== undefined) flow.userCode = code;
    }
    // Only ever forward, and never out of `completing`: a CLI that echoes its
    // own prompt after the code was sent must not drag the state backwards
    // while a client is polling for the answer.
    if (
      (flow.state === 'starting' || flow.state === 'awaiting_browser') &&
      looksLikeCodePrompt(flow.output)
    ) {
      flow.state = 'awaiting_code';
    }
  };

  return {
    start(profile) {
      if (current !== null && !isSignInSettled(current.state)) {
        throw new SignInBusyError(current.label);
      }

      const spec = profile.credentials.signIn;
      if (spec.staticStatus !== undefined || spec.loginArgs.length === 0) {
        // A provider whose profiles authenticate with a token or an address has
        // no login to drive. Saying so beats spawning `true` and reporting a
        // sign-in that did nothing.
        throw new SignInUnavailableError(
          `${profile.providerId} accounts have no login to run — they authenticate with an address or a key, not an account.`,
        );
      }

      const executable = resolveExecutable(spec.executable, hostEnv);
      if (executable === undefined) {
        throw new SignInUnavailableError(
          `The "${spec.executable}" CLI is not installed on this server, or is not on the PATH the server process sees. Install it in the server image, then try again.`,
        );
      }

      /*
       * The scrubbed environment `adapters/signIn.ts` builds, rebuilt here
       * rather than imported: an inherited `ANTHROPIC_API_KEY` outranks a
       * subscription login, so a login run with one in the environment writes —
       * or reports — the wrong account. Every credential variable the provider
       * names is removed and the config directory is forced.
       */
      const env = { ...hostEnv };
      for (const key of profile.credentials.credentialEnvKeys) delete env[key];
      env[profile.credentials.configDirVar] = profile.configDir;
      // The CLI must take the no-browser path: there is no display in a
      // container, and a CLI that believes it opened a browser prints nothing
      // for the user to open themselves.
      env['BROWSER'] = 'echo';
      delete env['DISPLAY'];

      const startedAt = now();
      const viaShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
      const child = spawnProcess(executable, [...spec.loginArgs], {
        env,
        cwd: profile.configDir,
        // Pipes on all three. Stdin is the half that makes this surface
        // possible at all — the CLI's no-browser path reads the pasted code
        // from it — and stdout is read incrementally rather than at exit,
        // because the URL is worthless once the flow is over.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so a shim's children die with it. Not
        // available on Windows; see `kill`.
        ...(process.platform === 'win32' ? {} : { detached: true }),
        ...(viaShell ? { shell: true } : {}),
      });

      const flow: Flow = {
        profileId: profile.id,
        label: profile.label,
        configDir: profile.configDir,
        credentials: profile.credentials,
        startedAt,
        expiresAt: startedAt + timeoutMs,
        child,
        timer: setTimeout(() => {
          settle(
            flow,
            'expired',
            `Nobody finished this sign-in within ${String(Math.round(timeoutMs / 60_000))} minutes, so it was stopped. Start another one when you are ready.`,
          );
        }, timeoutMs),
        state: 'starting',
        output: '',
        submittedAt: 0,
      };
      // A timer that outlives the process would keep a container alive for ten
      // minutes after everything else had shut down.
      flow.timer?.unref?.();
      current = flow;

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => read(flow, chunk));
      // Stderr is read for the same reasons stdout is: a CLI that prints its
      // URL there is not wrong, and its diagnosis is the only thing worth
      // reporting when the login fails.
      child.stderr?.on('data', (chunk: string) => read(flow, chunk));
      child.on('error', (error: Error) => {
        settle(flow, 'failed', `The ${spec.executable} CLI could not be started: ${error.message}`);
      });
      child.on('close', (code: number | null) => {
        void finish(flow, code);
      });

      return snapshot(flow);
    },

    status(profileId) {
      if (current === null || String(current.profileId) !== profileId) return undefined;
      return snapshot(current);
    },

    submitCode(profileId, code) {
      const flow = current;
      if (flow === null || String(flow.profileId) !== profileId) {
        throw new SignInNotWaitingError('failed');
      }
      if (flow.state !== 'awaiting_code' && flow.state !== 'awaiting_browser') {
        throw new SignInNotWaitingError(flow.state);
      }

      flow.state = 'completing';
      // The previous rejection is the previous code's business. Leaving it set
      // would have a client showing "invalid code" beside a code that is still
      // being checked.
      flow.codeError = undefined;
      flow.submittedAt = flow.output.length;
      const stdin = flow.child?.stdin;
      if (stdin === undefined || stdin === null || stdin.destroyed) {
        settle(flow, 'failed', 'The sign-in process is no longer accepting input.');
        return snapshot(flow);
      }
      // The code and a newline, and nothing else ever goes into this pipe. It
      // is never logged, never echoed into an error, and never kept: what the
      // CLI does with it is the CLI's business.
      stdin.write(`${code}\n`);
      return snapshot(flow);
    },

    cancel(profileId) {
      if (current === null || String(current.profileId) !== profileId) return undefined;
      settle(current, 'cancelled');
      return snapshot(current);
    },

    close() {
      if (current === null) return;
      settle(current, 'cancelled');
      current = null;
    },
  };

  /**
   * What the subprocess exiting means, which is not what its exit code says.
   *
   * The directory decides, exactly as it does for the desktop's polled path:
   * a CLI can exit `0` having written nothing (the user closed the browser), and
   * can exit non-zero having written a perfectly good credential (a warning on
   * the way out). So the answer is the status probe's, and the exit code is
   * only used to write a better sentence when the probe says no.
   */
  async function finish(flow: Flow, code: number | null): Promise<void> {
    if (isSignInSettled(flow.state)) return;
    if (flow.timer !== undefined) clearTimeout(flow.timer);

    let status: AuthStatus;
    try {
      status = await probe({
        credentials: flow.credentials,
        configDir: flow.configDir,
        hostEnv,
      });
    } catch (error) {
      flow.state = 'failed';
      flow.error = `The sign-in finished but its result could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return;
    }

    if (isSignInSettled(flow.state)) return;

    if (status.loggedIn) {
      flow.state = 'done';
      flow.account = {
        ...(status.authMethod === undefined ? {} : { authMethod: status.authMethod }),
        ...(status.email === undefined ? {} : { email: status.email }),
        ...(status.orgName === undefined ? {} : { orgName: status.orgName }),
        ...(status.subscriptionType === undefined
          ? {}
          : { subscriptionType: status.subscriptionType }),
      };
      return;
    }

    flow.state = 'failed';
    /*
     * Whose sentence wins, and why the CLI's raw output is not a candidate.
     *
     * The probe's `error` is a fact about the directory; the exit code is a
     * fact about the process. The subprocess's stdout is neither — it is
     * unbounded text from a program this server does not control, on a path
     * where the user has just typed a secret into the same stream. The one
     * exception is `codeError`, which is a single recognised line, scrubbed,
     * and is carried because a login that died after refusing a code is not
     * usefully described by "exited with code 1".
     */
    flow.error =
      flow.codeError ??
      status.error ??
      (code === 0
        ? 'The sign-in ended without writing a credential. It was probably cancelled in the browser.'
        : `The sign-in command exited with code ${String(code)} and the account is still signed out.`);
    // Terminal now: the retry field would otherwise invite a client to offer a
    // code box for a subprocess that has gone.
    flow.codeError = undefined;
  }
}
