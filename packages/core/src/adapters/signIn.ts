/**
 * Signing a profile in, by driving Anthropic's own CLI.
 *
 * ## Why Libra performs no login of its own
 *
 * Libra never sees a credential under this design. `claude auth login` opens
 * the browser, completes the OAuth exchange, and writes the token into the
 * profile's own config directory. Libra supplies one environment variable —
 * `CLAUDE_CONFIG_DIR` — and reads a boolean back. There is no token to paste,
 * store, encrypt, mask or leak, and no `ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN` billing trap to get wrong, because Libra stops
 * setting either.
 *
 * ## Why this preserves multiple accounts
 *
 * Verified on macOS, same machine, same moment:
 *
 *     CLAUDE_CONFIG_DIR=<temp>  →  { loggedIn: false, authMethod: 'none' }
 *     (ambient)                 →  { loggedIn: true,  subscriptionType: 'max' }
 *
 * `CLAUDE_CONFIG_DIR` isolates the *credential*, not merely settings — so a
 * login performed with it set belongs to that directory alone. Libra already
 * gives every profile its own directory, which is the whole mechanism: one
 * profile, one folder, one account.
 *
 * (The official docs describe macOS credentials as living in the Keychain,
 * which reads as though the config directory could not isolate them. The
 * observed behaviour above says otherwise, and it is what this file is built
 * on.)
 */

import { spawn } from 'node:child_process';

/** What the CLI reports about a config directory's authentication. */
export interface AuthStatus {
  readonly loggedIn: boolean;
  /** `claude.ai` for a subscription, `console` for API billing, `none` when signed out. */
  readonly authMethod?: string;
  /** Present when signed in. Shown so a user can tell two accounts apart. */
  readonly email?: string;
  readonly orgName?: string;
  /** `pro`, `max`, `team`, `enterprise` — absent on Console/API logins. */
  readonly subscriptionType?: string;
  /** Set when the status could not be read at all, rather than read as "signed out". */
  readonly error?: string;
}

/** How a profile should authenticate. */
export type SignInMode = 'subscription' | 'console';

export interface SignInOptions {
  /** The profile's isolated config directory. This is what scopes the login. */
  readonly configDir: string;
  /** Inherited environment. `PATH` and `HOME` must survive or the CLI cannot run. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Path to the `claude` executable. Defaults to resolving it on `PATH`. */
  readonly executable?: string;
  /** Abandon a login the user never completed in the browser. */
  readonly timeoutMs?: number;
}

/**
 * The environment the CLI runs under.
 *
 * `CLAUDE_CONFIG_DIR` is forced to the profile's directory, and the two
 * credential variables are stripped: an inherited `ANTHROPIC_API_KEY` outranks
 * a subscription login (documented precedence), so leaving one in place would
 * let ambient shell state silently decide which account — and which bill — a
 * profile uses. That is the exact failure this design exists to remove.
 */
function childEnv(options: SignInOptions): NodeJS.ProcessEnv {
  const env = { ...(options.hostEnv ?? process.env) };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  delete env['CLAUDE_CODE_OAUTH_TOKEN'];
  env['CLAUDE_CONFIG_DIR'] = options.configDir;
  return env;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], options: SignInOptions, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(options.executable ?? 'claude', [...args], {
      env: childEnv(options),
      // The login flow prints a URL and waits; it must not inherit a TTY it
      // does not have, and its output is what we report back.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** Parse `claude auth status --json`, tolerating anything that is not the expected shape. */
export function parseAuthStatus(stdout: string): AuthStatus {
  // The CLI may print notices before the JSON, so take the outermost object.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { loggedIn: false, error: 'The CLI did not return a readable status.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return { loggedIn: false, error: 'The CLI returned a status that could not be parsed.' };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { loggedIn: false, error: 'The CLI returned an unexpected status.' };
  }

  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : undefined;

  return {
    // Strictly `=== true`: a missing field must read as signed out, never as
    // signed in, or a profile with no credential would look ready to run.
    loggedIn: raw['loggedIn'] === true,
    ...(str('authMethod') === undefined ? {} : { authMethod: str('authMethod') }),
    ...(str('email') === undefined ? {} : { email: str('email') }),
    ...(str('orgName') === undefined ? {} : { orgName: str('orgName') }),
    ...(str('subscriptionType') === undefined ? {} : { subscriptionType: str('subscriptionType') }),
  };
}

/**
 * Is this profile's directory signed in?
 *
 * Cheap and side-effect free — safe to call whenever the UI needs to know.
 * Never throws: a missing CLI is reported as signed-out-with-a-reason, because
 * every caller is UI that has to render something either way.
 */
export async function checkAuthStatus(options: SignInOptions): Promise<AuthStatus> {
  const result = await run(['auth', 'status', '--json'], options, options.timeoutMs ?? 15_000);

  // A signed-out directory legitimately exits non-zero on some versions, and
  // still prints usable JSON. Prefer the JSON, fall back to the exit code.
  const parsed = parseAuthStatus(result.stdout);
  if (parsed.error === undefined) return parsed;

  return {
    loggedIn: false,
    error:
      result.stderr.trim() ||
      (result.code === null
        ? 'Could not run the Claude CLI. Check that `claude` is installed and on your PATH.'
        : `The Claude CLI exited with code ${result.code}.`),
  };
}

/**
 * Sign this profile in.
 *
 * Opens the browser via the CLI and resolves once the flow completes. The
 * default timeout is generous because a human is signing in on the other side.
 *
 * Resolves with the resulting status rather than rejecting: "the user closed
 * the browser" is an ordinary outcome, not an exception.
 */
export async function signIn(
  options: SignInOptions & { readonly mode?: SignInMode },
): Promise<AuthStatus> {
  const mode = options.mode ?? 'subscription';
  const result = await run(
    ['auth', 'login', mode === 'console' ? '--console' : '--claudeai'],
    options,
    options.timeoutMs ?? 5 * 60_000,
  );

  // Trust the directory over the exit code: what matters is whether a
  // credential now exists, not how the process reported its own exit.
  const status = await checkAuthStatus(options);
  if (status.loggedIn) return status;

  return {
    loggedIn: false,
    error:
      result.stderr.trim() || 'Sign-in did not complete. The browser window may have been closed.',
  };
}

/** Sign this profile out, clearing the credential from its directory. */
export async function signOut(options: SignInOptions): Promise<void> {
  await run(['auth', 'logout'], options, options.timeoutMs ?? 30_000);
}
