/**
 * Driving a provider login from a server, against a CLI that behaves like one.
 * ============================================================================
 *
 * The parsing is unit-testable and is tested that way; the state machine is
 * not, because every interesting transition is a reaction to a *subprocess* —
 * output arriving in pieces, a prompt, a rejection, an exit. So the machine is
 * exercised against a real child process running a scripted stand-in for
 * `claude auth login`: it prints a verification URL, asks for a code on stdin,
 * refuses the first one the way the real CLI does, accepts the second, and
 * writes a credential file that the status probe then reads.
 *
 * The precedent is `adapters/__tests__/codex.test.ts`, which scripts a fake
 * app-server the same way. What is different here is the executable: the fake
 * is launched as `node <script>` rather than through a `.cmd` shim, because
 * this director resolves an absolute path straight through and the shim exists
 * in that other test only to satisfy a `PATH` lookup.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProfileId, ServerSignInStatus } from '@rx-artemis/protocol';

import type { ProviderCredentialSpec } from '../../adapters/types.js';
import {
  createSignInDirector,
  findCodeRejection,
  findUserCode,
  findVerificationUrl,
  looksLikeCodePrompt,
  resolveExecutable,
  SignInBusyError,
  SignInNotWaitingError,
  SignInUnavailableError,
  type ServerProfileRecord,
  type SignInDirector,
} from '../signin.js';

/* -------------------------------------------------------------------------- */
/* Reading the CLI's output                                                   */
/* -------------------------------------------------------------------------- */

describe('findVerificationUrl', () => {
  it('takes the first address, which is the one the login printed', () => {
    // Later ones are documentation links and update notices. A login prints
    // the address it wants opened before it prints anything else.
    const output =
      'Browser did not open.\n  https://claude.ai/oauth/authorize?code=true\nDocs: https://docs.example/help\n';
    expect(findVerificationUrl(output)).toBe('https://claude.ai/oauth/authorize?code=true');
  });

  it('trims the punctuation that ended the sentence, not the URL', () => {
    expect(findVerificationUrl('Open https://example.com/a.')).toBe('https://example.com/a');
    expect(findVerificationUrl('Open (https://example.com/a).')).toBe('https://example.com/a');
  });

  it('sees through the colours a CLI adds when it thinks it has a terminal', () => {
    // The escape bytes land inside the token a naive matcher is looking for.
    expect(findVerificationUrl('[4mhttps://example.com/x[0m')).toBe(
      'https://example.com/x',
    );
  });

  it('is absent until something has been printed', () => {
    expect(findVerificationUrl('')).toBeUndefined();
    expect(findVerificationUrl('Starting…')).toBeUndefined();
  });
});

describe('findUserCode', () => {
  it('reads the hyphenated confirmation some device flows show', () => {
    expect(findUserCode('Your code is WDJB-MJHT')).toBe('WDJB-MJHT');
  });

  it('does not invent one out of a sentence', () => {
    // Claude's flow has no such code, so absent has to be the ordinary answer
    // rather than something a loose pattern fills in from prose.
    expect(findUserCode('Paste the code from your browser below')).toBeUndefined();
  });
});

describe('looksLikeCodePrompt', () => {
  it('recognises what the CLI actually prints', () => {
    expect(looksLikeCodePrompt('Paste code here if prompted > ')).toBe(true);
    expect(looksLikeCodePrompt('Enter the authorization code:')).toBe(true);
  });

  it('does not fire on the sentence that offers the URL', () => {
    expect(looksLikeCodePrompt('Opening https://claude.ai/oauth/authorize?code=true')).toBe(false);
  });
});

describe('findCodeRejection', () => {
  it('recognises the line the CLI prints for a half-copied code', () => {
    // Verbatim from `claude auth login`. This is the most common thing that
    // goes wrong in the whole flow, and it is not a failure.
    expect(findCodeRejection('Invalid code. Please make sure the full code was copied.')).toBe(
      'Invalid code. Please make sure the full code was copied.',
    );
  });

  it('stays quiet for the prompt itself', () => {
    expect(findCodeRejection('Paste code here if prompted > ')).toBeUndefined();
    expect(findCodeRejection('Login successful.')).toBeUndefined();
  });
});

describe('resolveExecutable', () => {
  it('takes an absolute path as given', () => {
    expect(resolveExecutable(process.execPath, {})).toBe(process.execPath);
  });

  it('finds a bare name on PATH', () => {
    const found = resolveExecutable(path.basename(process.execPath).replace(/\.exe$/i, ''), {
      PATH: path.dirname(process.execPath),
      PATHEXT: '.EXE;.CMD',
    });
    expect(found).toBeTruthy();
  });

  it('answers undefined rather than letting spawn fail later', () => {
    // The whole point of resolving first: a missing binary becomes one
    // sentence at the moment the caller asked, not an ENOENT on an event
    // after the route has already answered 200.
    expect(resolveExecutable('definitely-not-a-real-binary-9f3c', { PATH: '' })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The state machine, against a subprocess                                    */
/* -------------------------------------------------------------------------- */

/**
 * A scripted stand-in for `claude auth login` with no browser to open.
 *
 * It prints the URL, asks for a code, and refuses anything that is not `GOOD`
 * with the CLI's own wording — staying alive and asking again, which is the
 * behaviour the machine has to survive. On `GOOD` it writes a credential file
 * into its config directory and exits 0, so that "did it work" is answered by
 * the directory rather than by the exit code.
 */
const FAKE_LOGIN = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write('Signing in.\\n');
setTimeout(() => {
  process.stdout.write('Browser did not open. Visit:\\n');
  process.stdout.write('  https://claude.ai/oauth/authorize?code=true&state=abc\\n');
  process.stdout.write('Paste code here if prompted > ');
}, 20);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf('\\n');
  while (cut !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (line === 'GOOD') {
      fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
      process.stdout.write('Login successful.\\n', () => process.exit(0));
      return;
    }
    if (line === 'FATAL') {
      process.stdout.write('Giving up.\\n', () => process.exit(1));
      return;
    }
    process.stdout.write('Invalid code. Please make sure the full code was copied.\\n');
    process.stdout.write('Paste code here if prompted > ');
    cut = buffer.indexOf('\\n');
  }
});
`;

/** A fake that never says anything and never exits, for the timeout and cancel. */
const FAKE_SILENT = `'use strict';
setInterval(() => undefined, 1000);
`;

const cleanups: (() => Promise<void>)[] = [];

/**
 * Unwound in reverse, and the order is load-bearing on Windows.
 *
 * The subprocess runs *in* the config directory, and a directory that is some
 * process's working directory cannot be removed there. Tearing down in the
 * order things were made would delete the tree while the login was still alive
 * and fail with `EBUSY`; the director's `close` has to go first.
 */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A profile whose "CLI" is one of the scripts above, in a real directory. */
async function fakeProfile(script: string): Promise<ServerProfileRecord> {
  const dir = await mkdtemp(path.join(tmpdir(), 'artemis-signin-'));
  // Retried, because a killed process releases its handles a moment after the
  // signal and Windows refuses the removal in between.
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const file = path.join(dir, 'fake-login.cjs');
  await writeFile(file, script, 'utf8');
  const configDir = path.join(dir, 'config');
  await mkdir(configDir);

  const credentials: ProviderCredentialSpec = {
    configDirVar: 'CLAUDE_CONFIG_DIR',
    credentialEnvKeys: ['ANTHROPIC_API_KEY'],
    signIn: {
      // An absolute path, so the lookup is a passthrough — the shape a packaged
      // Artemis hands over, and the one that needs no PATH in a test.
      executable: process.execPath,
      loginArgs: [file],
      statusArgs: [],
      logoutArgs: [],
      howTo: 'fake',
    },
  };

  return {
    id: 'prof-fake' as ProfileId,
    label: 'Fake',
    providerId: 'claude',
    configDir,
    credentials,
  };
}

/**
 * The status probe, reading the directory the fake writes into.
 *
 * Injected rather than left at its default because the default spawns the
 * provider's status command, and this provider's "CLI" is `node` — which, given
 * no arguments, opens a REPL and waits forever.
 */
const probeDirectory = async (input: { readonly configDir: string }) =>
  existsSync(path.join(input.configDir, '.credentials.json'))
    ? { loggedIn: true, email: 'someone@example.com', subscriptionType: 'max' }
    : { loggedIn: false };

function director(overrides: Parameters<typeof createSignInDirector>[0] = {}): SignInDirector {
  const made = createSignInDirector({ checkStatus: probeDirectory, ...overrides });
  cleanups.push(async () => made.close());
  return made;
}

/** Poll the director until the snapshot satisfies `predicate`, or give up. */
async function until(
  signIns: SignInDirector,
  profileId: string,
  predicate: (status: ServerSignInStatus) => boolean,
): Promise<ServerSignInStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = signIns.status(profileId);
    if (status !== undefined && predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting. Last state: ${status?.state ?? 'none'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a sign-in driven from a client', () => {
  it('publishes the verification URL as soon as the CLI prints it', async () => {
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();

    // Nothing has been said yet, and `starting` is the honest answer rather
    // than a URL-less `awaiting_browser`.
    expect(signIns.start(profile).state).toBe('starting');

    const browsing = await until(signIns, profile.id, (s) => s.verificationUrl !== undefined);
    expect(browsing.verificationUrl).toBe('https://claude.ai/oauth/authorize?code=true&state=abc');
    // And it moves on by itself once the CLI asks for the code.
    expect((await until(signIns, profile.id, (s) => s.state === 'awaiting_code')).state).toBe(
      'awaiting_code',
    );
  });

  it('takes a rejected code as a retry, not a failure', async () => {
    /*
     * The case that makes this machine bidirectional. A code copied one
     * character short is the ordinary mistake, the CLI says so and asks again,
     * and a flow that settled on the first cross word would kill a login the
     * user was one paste away from finishing.
     */
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();
    signIns.start(profile);
    await until(signIns, profile.id, (s) => s.state === 'awaiting_code');

    expect(signIns.submitCode(profile.id, 'WRONG').state).toBe('completing');

    const rejected = await until(signIns, profile.id, (s) => s.codeError !== undefined);
    expect(rejected.state).toBe('awaiting_code');
    expect(rejected.codeError).toContain('full code was copied');
    // Still live: the subprocess is waiting, and there is nothing terminal here.
    expect(rejected.error).toBeUndefined();

    // The second paste is accepted, and what settles it is the directory.
    expect(signIns.submitCode(profile.id, 'GOOD').state).toBe('completing');
    const done = await until(signIns, profile.id, (s) => s.state === 'done');
    expect(done.codeError).toBeUndefined();
    expect(done.account).toEqual({ email: 'someone@example.com', subscriptionType: 'max' });
  });

  it('reports a login that exits having written nothing as failed', async () => {
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();
    signIns.start(profile);
    await until(signIns, profile.id, (s) => s.state === 'awaiting_code');

    signIns.submitCode(profile.id, 'FATAL');
    const failed = await until(signIns, profile.id, (s) => s.state === 'failed');
    // The directory decided, not the exit code — the message says the account
    // is still signed out rather than quoting a number nobody can act on.
    expect(failed.error).toBeTruthy();
    expect(failed.account).toBeUndefined();
  });

  it('refuses a second sign-in while one is live, and names who has the floor', async () => {
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();
    signIns.start(profile);

    expect(() => signIns.start({ ...profile, id: 'other' as ProfileId })).toThrow(SignInBusyError);
    try {
      signIns.start({ ...profile, id: 'other' as ProfileId });
    } catch (error) {
      expect((error as Error).message).toContain('Fake');
    }
  });

  it('lets another start once the first has settled', async () => {
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();
    signIns.start(profile);
    signIns.cancel(profile.id);

    expect(signIns.start(profile).state).toBe('starting');
  });

  it('reports nothing for an account that has no flow', async () => {
    const profile = await fakeProfile(FAKE_LOGIN);
    const signIns = director();
    expect(signIns.status(profile.id)).toBeUndefined();
    expect(signIns.cancel(profile.id)).toBeUndefined();

    signIns.start(profile);
    // The flow is the server's one flow, not this account's: a poll aimed at a
    // different account must not read someone else's URL.
    expect(signIns.status('someone-else')).toBeUndefined();
  });

  it('kills the subprocess on cancel', async () => {
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director();
    signIns.start(profile);

    expect(signIns.cancel(profile.id)?.state).toBe('cancelled');
    expect(signIns.status(profile.id)?.state).toBe('cancelled');
  });

  it('expires a sign-in nobody came back to, and says which it was', async () => {
    // `expired` rather than `failed`: nothing went wrong except time, and the
    // two need different sentences in front of a person.
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director({ timeoutMs: 40 });
    const started = signIns.start(profile);
    expect(started.expiresAt).toBe(started.startedAt + 40);

    const expired = await until(signIns, profile.id, (s) => s.state === 'expired');
    expect(expired.error).toContain('finish');
  });

  it('refuses a code when nothing is waiting for one', async () => {
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director();
    expect(() => signIns.submitCode(profile.id, 'X')).toThrow(SignInNotWaitingError);

    signIns.start(profile);
    signIns.cancel(profile.id);
    expect(() => signIns.submitCode(profile.id, 'X')).toThrow(SignInNotWaitingError);
  });

  it('will not spawn a login for a provider that has none', async () => {
    // A token-authenticated profile has no account to sign in. Saying so beats
    // spawning something that reports a sign-in which did nothing.
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director();
    expect(() =>
      signIns.start({
        ...profile,
        credentials: {
          ...profile.credentials,
          signIn: { ...profile.credentials.signIn, staticStatus: { loggedIn: true } },
        },
      }),
    ).toThrow(SignInUnavailableError);
  });

  it('says plainly when the provider CLI is not installed here', async () => {
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director({ hostEnv: { PATH: '' } });
    expect(() =>
      signIns.start({
        ...profile,
        credentials: {
          ...profile.credentials,
          signIn: { ...profile.credentials.signIn, executable: 'claude' },
        },
      }),
    ).toThrow(/not installed on this server/);
  });

  it('strips the provider credentials the environment happens to carry', async () => {
    /*
     * An inherited `ANTHROPIC_API_KEY` outranks a subscription login, so a
     * login run with one in the environment signs in — or reports — the wrong
     * account. The fake proves the variable does not reach the child by
     * refusing to write a credential if it sees one.
     */
    const profile = await fakeProfile(`'use strict';
const fs = require('node:fs');
const path = require('node:path');
if (!process.env.ANTHROPIC_API_KEY && process.env.CLAUDE_CONFIG_DIR) {
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
}
process.stdout.write('done\\n', () => process.exit(0));
`);
    const signIns = director({
      hostEnv: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-not-survive' },
    });
    signIns.start(profile);

    expect((await until(signIns, profile.id, (s) => s.state === 'done')).state).toBe('done');
  });

  it('drops a live sign-in when the server closes', async () => {
    const profile = await fakeProfile(FAKE_SILENT);
    const signIns = director();
    signIns.start(profile);

    signIns.close();
    // The subprocess is a real process parked on a person who can no longer
    // reach it; stopping the server is the last moment anything knows it is
    // there.
    expect(signIns.status(profile.id)).toBeUndefined();
  });
});
