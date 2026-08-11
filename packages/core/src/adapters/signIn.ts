/**
 * Signing a profile in, by handing the user their provider's own command.
 *
 * ## Apollo performs no login
 *
 * Apollo never sees a credential under this design. `claude auth login` opens
 * the browser, completes the OAuth exchange, and writes the token into the
 * profile's own config directory. Apollo supplies one environment variable —
 * `CLAUDE_CONFIG_DIR` — and reads a boolean back. There is no token to paste,
 * store, encrypt, mask or leak, and no `ANTHROPIC_API_KEY` /
 * `CLAUDE_CODE_OAUTH_TOKEN` billing trap to get wrong, because Apollo sets
 * neither and strips both.
 *
 * ## Why the user runs it, rather than Apollo spawning it
 *
 * Apollo used to spawn the login itself. It worked, and it was worse:
 *
 *  - The subprocess had to be held open for up to five minutes around a browser
 *    flow Apollo could not observe, so the only failure it could report was a
 *    timeout — for a login that had actually succeeded, or one where the CLI
 *    had asked a question nobody could see, alike.
 *  - `claude auth login` is interactive. Spawned with `stdio: 'ignore'` on
 *    stdin, any prompt it raises is unanswerable and the process simply hangs.
 *  - A user who hit trouble had nothing to retry, nothing to read, and nothing
 *    to paste into a search or a bug report.
 *
 * {@link signInCommand} produces a line the user can read, run, re-run and
 * quote. {@link checkAuthStatus} is then polled until the directory answers
 * differently, which is the same question the old code asked *after* its
 * subprocess exited — it was always the directory that decided, never the exit
 * code.
 */

import { spawn } from 'node:child_process';

import type { ProviderCredentialSpec } from './types.js';

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

export interface SignInOptions {
  /** The provider's vocabulary — argv and variable names. */
  readonly credentials: ProviderCredentialSpec;
  /** The profile's config directory. This is what scopes the login. */
  readonly configDir: string;
  /** Inherited environment. `PATH` and `HOME` must survive or the CLI cannot run. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Override the executable. Defaults to the spec's, resolved on `PATH`. */
  readonly executable?: string;
  /** Abandon a probe that is not answering. */
  readonly timeoutMs?: number;
}

/**
 * Quote one argument for a POSIX shell, if it needs it.
 *
 * The config directory is the reason this exists: it is a path the *user*
 * chose, so it can contain spaces, and a command that breaks when pasted is
 * worse than no command at all. Single quotes are used because nothing inside
 * them is interpreted — a path containing `$`, backticks or a backslash is safe
 * — with the standard `'\''` dance for an embedded single quote.
 */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The command a user runs to sign this profile in.
 *
 * A single line, safe to paste into a POSIX shell, that sets the config
 * directory inline rather than exporting it — so it scopes to this one command
 * and cannot leak into the rest of the user's session and quietly re-point
 * their next `claude` invocation.
 *
 * ```
 * CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/Apollo/profiles/work' claude auth login
 * ```
 *
 * Windows shells need a different spelling (`$env:` in PowerShell, `set` in
 * cmd). That is a rendering concern for whoever displays this, not a reason to
 * emit something no shell accepts.
 */
export function signInCommand(options: {
  readonly credentials: ProviderCredentialSpec;
  readonly configDir: string;
}): string {
  const { credentials, configDir } = options;
  const assignment = `${credentials.configDirVar}=${shellQuote(configDir)}`;
  const argv = [credentials.signIn.executable, ...credentials.signIn.loginArgs].map(shellQuote);
  return `${assignment} ${argv.join(' ')}`;
}

/**
 * The environment a status probe runs under.
 *
 * `CLAUDE_CONFIG_DIR` is forced to the profile's directory, and every
 * credential variable is stripped: an inherited `ANTHROPIC_API_KEY` outranks a
 * subscription login, so leaving one in place would make a signed-out directory
 * report itself signed in — as the wrong account.
 */
function childEnv(options: SignInOptions): NodeJS.ProcessEnv {
  const env = { ...(options.hostEnv ?? process.env) };
  for (const key of options.credentials.credentialEnvKeys) delete env[key];
  env[options.credentials.configDirVar] = options.configDir;
  return env;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  args: readonly string[],
  options: SignInOptions,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(options.executable ?? options.credentials.signIn.executable, [...args], {
      env: childEnv(options),
      // Nothing here is interactive — the interactive command is the one the
      // *user* runs. Stdin is closed so a probe that unexpectedly prompts fails
      // fast instead of hanging until the timeout.
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
 * Cheap and side-effect free — safe to poll while the user completes a login in
 * their own terminal, which is exactly what the profile screen does. Never
 * throws: a missing CLI is reported as signed-out-with-a-reason, because every
 * caller is UI that has to render something either way.
 */
export async function checkAuthStatus(options: SignInOptions): Promise<AuthStatus> {
  const result = await run(
    options.credentials.signIn.statusArgs,
    options,
    options.timeoutMs ?? 15_000,
  );

  // A signed-out directory legitimately exits non-zero on some versions, and
  // still prints usable JSON. Prefer the JSON, fall back to the exit code.
  const parsed = parseAuthStatus(result.stdout);
  if (parsed.error === undefined) return parsed;

  return {
    loggedIn: false,
    error:
      result.stderr.trim() ||
      (result.code === null
        ? `Could not run the ${options.credentials.signIn.executable} CLI. Check that it is installed and on your PATH.`
        : `The CLI exited with code ${result.code}.`),
  };
}

/** Sign this profile out, clearing the credential from its directory. */
export async function signOut(options: SignInOptions): Promise<AuthStatus> {
  await run(options.credentials.signIn.logoutArgs, options, options.timeoutMs ?? 30_000);
  // Report what the directory *actually* says afterwards rather than assuming
  // the logout took: a failed sign-out rendered as signed-out would leave the
  // real credential in place while the UI claimed otherwise.
  return checkAuthStatus(options);
}
