/**
 * The encrypted side of a team memory bank's git credential.
 * ============================================================================
 *
 * `core/memorybanks/secrets.ts` says why this token exists at all and what
 * rules it lives under; this is the half that needs Electron, and it is
 * deliberately the same small shape as `profileSecrets.ts`. One file, one JSON
 * object, `slug → record`, written `0600` under `userData` rather than into
 * the banks' own `~/.config/cerebro/config.json` — that file is plain,
 * hand-editable, and written by a Python CLI that knows nothing about any of
 * this.
 *
 * ## What is encrypted and what is not
 *
 * The token is; the username is not. That asymmetry is the point rather than
 * an oversight — git echoes the username into its own error output, which
 * Artemis shows the user, so pretending to protect it would be a claim the
 * rest of the system does not honour. A reader of this file can see exactly
 * which of the two values Artemis treats as a secret.
 *
 * ## The seam phase B2 opens
 *
 * A stored record is `{ username, token }` where `token` is base64 ciphertext.
 * The next phase adds a second variant — a *reference* to a key held by the
 * machine's own key manager — and it belongs in this same file as a different
 * field on the same record, resolved by the same `read`. Everything above
 * {@link MemoryBankSecrets} asks "how do I authenticate to this bank" and
 * never learns which variant answered.
 *
 * ## When encryption is unavailable
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no
 * keyring, and briefly false on any platform before `app.ready`. Writing the
 * token in clear at that point would be a silent downgrade from encrypted to
 * not — the one failure mode a boundary must never have — so the write fails
 * loudly and the pane reports that the bank could not be joined *with* a
 * token. A user who cannot store one can still join a public bank, or one
 * their ssh key already reaches.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import type { MemoryBankCredential, MemoryBankSecrets } from '@rx-artemis/core';
import { secretRefProblem, type SecretRef } from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('memory-bank-secrets');

/** Under `userData`, beside the master switch and never inside the CLI's config. */
const SECRETS_FILE = 'memory-bank-tokens.json';

/**
 * One bank's stored authentication.
 *
 * Two variants in one file, because "how does this bank authenticate" is one
 * question. The token variant keeps base64 ciphertext; the reference variant
 * keeps a plain object, and that it is plain is the point rather than an
 * oversight — a reference names a secret and is not one, so encrypting it
 * would be a claim this file does not otherwise make. A reader can see at a
 * glance which banks put a credential on this machine and which did not.
 */
type StoredCredential =
  | { readonly kind: 'token'; readonly username: string; readonly token: string }
  | { readonly kind: 'ref'; readonly username: string; readonly ref: SecretRef };

type SecretsDocument = Record<string, StoredCredential>;

/**
 * A stored reference, rebuilt field by field and re-checked.
 *
 * Re-checked on the way *out* of the file, not only on the way in, because
 * this file is not the same thing as an IPC payload: it sits on disk between
 * runs, a person can edit it, and a `..` written into it by hand would
 * otherwise reach a URL builder having passed no validator at all. The same
 * grammar the renderer and `validate.ts` use, from the same function.
 */
function readStoredRef(value: unknown): SecretRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const connectionId = raw['connectionId'];
  if (typeof connectionId !== 'string') return null;

  let ref: SecretRef;
  if (raw['provider'] === 'openbao') {
    const { mount, path, key, kvVersion } = raw;
    if (typeof mount !== 'string' || typeof path !== 'string' || typeof key !== 'string') return null;
    ref = {
      provider: 'openbao',
      connectionId,
      mount,
      path,
      key,
      ...(kvVersion === 1 || kvVersion === 2 || kvVersion === 'auto' ? { kvVersion } : {}),
    };
  } else if (raw['provider'] === 'doppler') {
    const { name, project, config } = raw;
    if (typeof name !== 'string') return null;
    ref = {
      provider: 'doppler',
      connectionId,
      name,
      ...(typeof project === 'string' ? { project } : {}),
      ...(typeof config === 'string' ? { config } : {}),
    };
  } else {
    return null;
  }
  return secretRefProblem(ref) === null ? ref : null;
}

/**
 * A `safeStorage`-backed {@link MemoryBankSecrets}.
 *
 * Reads the whole document per call rather than caching it, for
 * `profileSecrets.ts`'s reason: the file holds one short record per private
 * bank and is touched when a user joins one or a run starts — never in a loop
 * — so a cache would buy nothing and would have to be invalidated by a second
 * Artemis window writing the same file.
 */
export function createMemoryBankSecrets(userDataDir: string): MemoryBankSecrets {
  const file = join(userDataDir, SECRETS_FILE);

  async function read(): Promise<SecretsDocument> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const document: SecretsDocument = {};
      for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry['username'] !== 'string') continue;
        const username = entry['username'];
        if (entry['kind'] === 'ref') {
          const ref = readStoredRef(entry['ref']);
          if (ref !== null) document[slug] = { kind: 'ref', username, ref };
          continue;
        }
        // A record with no `kind` predates references and is a token, which is
        // what makes the upgrade a no-op for every machine that already had
        // one. There is no migration step and no rewrite of this file.
        if (typeof entry['token'] !== 'string') continue;
        document[slug] = { kind: 'token', username, token: entry['token'] };
      }
      return document;
    } catch (error) {
      // A missing file is the ordinary state — most banks are public or reached
      // over ssh. A corrupt one is reported and treated as empty: refusing to
      // start over a damaged token file would take every other bank with it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${SECRETS_FILE}; treating it as empty.`, error);
      }
      return {};
    }
  }

  async function write(document: SecretsDocument): Promise<void> {
    // Written to a sibling and renamed, so an interrupted write cannot leave a
    // truncated file that reads as "every bank lost its token".
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    async read(slug: string): Promise<MemoryBankCredential | null> {
      const stored = (await read())[slug];
      if (stored === undefined) return null;
      // A reference is not encrypted, so it is readable on a machine whose
      // keyring is unavailable — which is the arrangement working as intended
      // rather than a hole: what is unreadable there is the *value*, and that
      // was never on this machine to begin with.
      if (stored.kind === 'ref') {
        return { kind: 'ref', username: stored.username, ref: stored.ref };
      }
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn(`A token is stored for '${slug}' but this session cannot decrypt it.`);
        return null;
      }
      try {
        return {
          kind: 'token',
          username: stored.username,
          token: safeStorage.decryptString(Buffer.from(stored.token, 'base64')),
        };
      } catch (error) {
        // A token encrypted under a keychain entry that has since been removed,
        // or a file copied from another machine. Reported as absent, because
        // that is what it now is — the bank syncs as an unauthenticated one and
        // says so when the remote refuses.
        log.warn(`The stored token for '${slug}' could not be decrypted.`, error);
        return null;
      }
    },

    async write(slug: string, credential: MemoryBankCredential): Promise<void> {
      const document = await read();
      if (credential.kind === 'ref') {
        // No encryption needed and none demanded: a machine with no keyring
        // can still join a bank this way, which is one more reason to prefer
        // it. There is nothing here that `safeStorage` would be protecting.
        document[slug] = { kind: 'ref', username: credential.username, ref: credential.ref };
        await write(document);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'This system has no secure storage available, so the access token cannot be saved.',
        );
      }
      document[slug] = {
        kind: 'token',
        username: credential.username,
        token: safeStorage.encryptString(credential.token).toString('base64'),
      };
      await write(document);
    },

    async clear(slug: string): Promise<void> {
      const document = await read();
      if (!(slug in document)) return;
      delete document[slug];
      // The last token leaving takes the file with it, so an Artemis holding no
      // bank credentials has no credential file — which is a thing a user can
      // check for themselves.
      if (Object.keys(document).length === 0) {
        await unlink(file).catch(() => undefined);
        return;
      }
      await write(document);
    },

    async has(slug: string): Promise<boolean> {
      // Deliberately does not decrypt; see the interface.
      return slug in (await read());
    },

    async list(): Promise<readonly string[]> {
      return Object.keys(await read());
    },
  };
}
