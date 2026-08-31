/**
 * Handing git a token without letting anything else see it.
 * ============================================================================
 *
 * A private memory bank is cloned, fetched and pushed by `git`, spawned by the
 * banks' CLI, spawned by Artemis. Artemis holds the token; git has to use it;
 * nothing in between may keep a copy. There are four obvious ways to do that
 * and three of them leak:
 *
 *  - **In the URL** (`https://user:token@host/org/bank.git`). Git writes the
 *    remote into `.git/config` on clone, prints it in `git remote -v`, and
 *    quotes it back in almost every error — including the ones this module's
 *    caller folds into a receipt the renderer shows. The token would end up on
 *    disk in plain text inside the bank the user just joined.
 *  - **On the command line.** Every process on the machine can read another's
 *    arguments. A token in `argv` is a token in `ps`.
 *  - **In `~/.git-credentials`.** Plain text, machine-wide, and it outlives
 *    the bank it was for.
 *  - **Through a credential helper, fed by the environment.** What this does.
 *
 * The helper is inlined as a shell function in `GIT_CONFIG_VALUE_*` and its
 * whole body is `echo username=…; echo "password=$ARTEMIS_GIT_TOKEN"`. The
 * config value carries the *name* of the variable, never its contents, so the
 * secret exists in exactly one place — the environment block of the process
 * Artemis spawned — and git reads it from there itself.
 *
 * ## Why the empty helper at index 0
 *
 * Because Git Credential Manager is installed by default with Git for Windows
 * and it wins otherwise. Measured on a Windows machine against a private
 * Forgejo remote: with only the scoped helper configured, GCM answered first
 * out of its own store, presented a *different* cached identity, and the clone
 * failed with an authentication error naming an account the user had not
 * chosen. The empty value is git's documented way of resetting the helper
 * chain, and it has to come first because the reset clears everything
 * configured before it — including, if the order were reversed, ours.
 *
 * ## Why the username is never the token
 *
 * GitHub and Forgejo accept a token in either slot, which makes
 * `https://<token>@host/…` and `username=<token>` look like harmless
 * shorthands. They are not: git echoes the *username* into prompts and into
 * error strings ("Authentication failed for 'https://<user>@host/…'"), and
 * `memoryBanks.ts` deliberately shows the tail of git's stderr to the user
 * because that is where the CLI states its conclusion. A token in the username
 * slot is therefore a token in the pane, and in the log beside it. The
 * username here is always a non-secret literal — `x-access-token` by default,
 * which is the value GitHub documents and every host in reach ignores — and
 * {@link gitCredentialUsernameProblem} refuses anything that could be a
 * credential wearing a username's clothes.
 *
 * ## Scope
 *
 * The helper is configured per origin (`credential.https://host.helper`), not
 * globally, so a spawn that also touches an unrelated remote does not offer it
 * this token. `https:` only — a token sent over plain `http:` crosses the
 * network in clear, and there is no version of "the user typed http" that
 * makes that acceptable.
 *
 * Nothing here reads or writes anything: give it a credential, get an
 * environment block. That is what makes it the unit under test, and the test
 * asserts the property this file exists for — that no value in the block
 * contains the token except the one variable that is supposed to.
 */

import { WorkspaceError } from './errors.js';

/**
 * The environment variable git is pointed at.
 *
 * Named for Artemis rather than for git, because it is not a variable git
 * knows: it exists only in the process Artemis spawns, and only the inline
 * helper this module writes ever dereferences it.
 */
export const GIT_TOKEN_ENV = 'ARTEMIS_GIT_TOKEN';

/**
 * The username presented when the user did not choose one.
 *
 * GitHub's documented literal for token authentication, and inert everywhere
 * else in reach: Forgejo and Gitea authenticate on the token alone and ignore
 * this field entirely. The hosts that *do* care — GitLab deploy tokens,
 * Bitbucket app passwords — need the account's own name, which is why the pane
 * offers a field rather than assuming this is always right.
 */
export const DEFAULT_GIT_USERNAME = 'x-access-token';

/** One host's credential: which origin it is for, and what to present there. */
export interface GitCredential {
  /** Scheme and host, as {@link credentialOrigin} produces it. */
  readonly origin: string;
  readonly token: string;
  /** Defaults to {@link DEFAULT_GIT_USERNAME}. */
  readonly username?: string;
}

/** An environment block to merge over `process.env` before spawning git. */
export type GitCredentialEnv = Readonly<Record<string, string>>;

/**
 * What a username may be.
 *
 * Conservative on purpose. This is not an attempt to enumerate every valid
 * account name on every git host — it is the shape of a thing that can be
 * pasted into a shell function body and into git's error output without
 * changing the meaning of either. A name outside it is far more likely to be a
 * token in the wrong field than an account nobody can otherwise authenticate.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;

/**
 * Why this username cannot be used, or `null` if it is fine.
 *
 * A message rather than a boolean, following `baseUrlProblem`: the validator
 * returns it as a field error and the pane renders it under the input, and
 * neither should be inventing wording for a rule defined here.
 */
export function gitCredentialUsernameProblem(value: string): string | null {
  if (value.length === 0) return 'A username is required, or leave the field empty for the default.';
  if (!USERNAME_PATTERN.test(value)) {
    return 'A username may only contain letters, digits and . _ @ + - — put the token in the token field.';
  }
  return null;
}

/**
 * The origin to scope a credential to, or `null` if this remote cannot carry
 * one.
 *
 * `null` is not a failure of the remote — an `ssh://` or `git@host:org/bank`
 * remote is a perfectly good bank, authenticated by a key this module has
 * nothing to do with. It means "there is no token to attach here", and the
 * caller spawns git without a credential block.
 */
export function credentialOrigin(remote: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(remote.trim());
  } catch {
    return null;
  }
  // `https:` only, and userinfo refused rather than stripped: a remote that
  // already carries credentials is one the user should be told about, not one
  // this quietly rewrites. `gitRemoteProblem` is where that is said out loud.
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.hostname.length === 0) return null;
  return parsed.origin;
}

/**
 * Why this string cannot be used as a bank's remote, or `null` if it can.
 *
 * Almost everything is allowed through, because almost everything is the git
 * CLI's to judge — it knows a hundred transports, and it answers for the ones
 * it does not have far better than a list maintained here would. One thing is
 * refused: **credentials in the URL**. Same rule, and nearly the same wording,
 * as `baseUrlProblem` applies to a local server's address, and for a stronger
 * reason: a secret in this field is written into `.git/config` when the bank
 * is cloned, echoed by `git remote -v`, and quoted back in git's own errors.
 * There is a field for the token two lines below it in the pane.
 *
 * "Credentials" means different things per transport, which is why the check
 * is not simply "does it contain an `@`". Over http(s) any userinfo at all is
 * a credential — that is the only thing the slot is for. Over ssh the user
 * part is a *login name*, and `git@github.com` is how every ssh remote in the
 * world is written; only an accompanying password is a secret there.
 */
export function gitRemoteProblem(remote: string): string | null {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return 'A remote URL is required.';

  // Only URL-shaped remotes are examined. `git@host:org/bank.git` is scp
  // syntax, and its `git@` is an ssh user rather than a credential.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'That is not a URL git can read.';
  }
  const web = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (parsed.password.length > 0 || (web && parsed.username.length > 0)) {
    return 'Put the token in the access-token field rather than in the URL.';
  }
  return null;
}

/**
 * The environment for one credential.
 *
 * The single-credential case is the one every interactive path takes (a join,
 * a manual sync, a verify), so it produces exactly the block described in the
 * file header — two config entries and one variable — rather than the indexed
 * general form.
 */
export function gitCredentialEnv(credential: GitCredential): GitCredentialEnv {
  return gitCredentialsEnv([credential]);
}

/**
 * The environment for several credentials at once.
 *
 * The background sync's case: one CLI pass covers every enabled bank, so every
 * bank's origin has to be configured before it starts. Each gets its own
 * numbered token variable; the reset at index 0 is shared, because it is one
 * statement about the helper chain rather than one per host.
 *
 * Two banks on the *same* origin collapse to the first — git scopes a helper
 * by host and cannot be told to try a second token for the same one. That is a
 * real limitation and a rare shape (two private banks on one host, under
 * different accounts); the first bank still syncs, and the second reports the
 * host's own authentication error rather than failing silently.
 */
export function gitCredentialsEnv(credentials: readonly GitCredential[]): GitCredentialEnv {
  const byOrigin = new Map<string, GitCredential>();
  for (const credential of credentials) {
    if (credential.token.length === 0) continue;
    if (!byOrigin.has(credential.origin)) byOrigin.set(credential.origin, credential);
  }
  if (byOrigin.size === 0) return {};

  const chosen = [...byOrigin.values()];
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(chosen.length + 1),
    // Index 0 resets the helper chain. See the file header: without it, Git
    // Credential Manager answers first with an identity of its own choosing.
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
  };

  chosen.forEach((credential, index) => {
    const username = credential.username ?? DEFAULT_GIT_USERNAME;
    const problem = gitCredentialUsernameProblem(username);
    if (problem !== null) {
      // Unreachable through the IPC boundary, which applies the same rule as a
      // field error. Kept as a throw because the alternative — quietly
      // substituting the default — would authenticate as somebody the user did
      // not name and report the host's refusal as a bad token.
      throw new WorkspaceError(`That git username cannot be used: ${problem}`);
    }
    const variable = chosen.length === 1 ? GIT_TOKEN_ENV : `${GIT_TOKEN_ENV}_${index}`;
    env[`GIT_CONFIG_KEY_${index + 1}`] = `credential.${credential.origin}.helper`;
    // The body names the variable; the shell dereferences it inside git's own
    // child process. Nothing on this line is a secret.
    env[`GIT_CONFIG_VALUE_${index + 1}`] =
      `!f() { echo username=${username}; echo "password=$${variable}"; }; f`;
    env[variable] = credential.token;
  });

  return env;
}
