/**
 * The encrypted side of a key-manager connection.
 * ============================================================================
 *
 * `core/secrets/credentials.ts` says why this credential is allowed to exist —
 * **the manager token exists so that git tokens never have to be stored** —
 * and what rules it lives under. This is the half that needs Electron, and it
 * is deliberately the same small shape as `profileSecrets.ts` and
 * `memoryBankSecrets.ts`: one file, one JSON object, `connectionId → record`,
 * written `0600` under `userData` and never inside `secret-managers.json`,
 * which is plain, hand-editable, and has its own test asserting there is no
 * credential in it.
 *
 * ## What is encrypted and what is not
 *
 * The token is; its expiry is not. That asymmetry is the same one the bank
 * store makes about a username, for the same reason: an expiry is a date, the
 * pane shows it, and encrypting it would be a claim the rest of the system
 * does not honour. A reader of this file can see exactly which of the two
 * values Artemis treats as a secret — and can see that the *only* thing
 * encrypted here is a token that expires on its own.
 *
 * ## Why there is no password in this file
 *
 * Because a `userpass` connection never stores one. The password is spent at
 * save time on a login, and what lands here is the token that login minted. If
 * a record in this file ever carried a password, the argument in
 * `core/secrets/credentials.ts` would have stopped being true — a stored
 * password works forever and is reusable against every other service the user
 * put it on, which is the opposite of the trade this store exists to make.
 *
 * ## When encryption is unavailable
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no
 * keyring, and briefly false on any platform before `app.ready`. Writing the
 * token in clear at that point would be a silent downgrade from encrypted to
 * not — the one failure mode a boundary must never have — so the write fails
 * loudly and the pane reports that the connection could not be saved. A user
 * who cannot store one can still paste a token into a bank directly, which is
 * the arrangement this feature was built to replace but not to forbid.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import type { SecretManagerCredential, SecretManagerCredentials } from '@rx-artemis/core';

import { createLogger } from './log.js';

const log = createLogger('secret-manager-secrets');

/** Under `userData`, beside the registry and never inside it. */
const SECRETS_FILE = 'secret-manager-credentials.json';

/** One connection's stored authentication: base64 ciphertext, plaintext expiry. */
interface StoredCredential {
  readonly token: string;
  readonly expiresAt?: number;
}

type SecretsDocument = Record<string, StoredCredential>;

/**
 * A `safeStorage`-backed {@link SecretManagerCredentials}.
 *
 * Reads the whole document per call rather than caching it, for
 * `profileSecrets.ts`'s reason: the file holds one short record per configured
 * manager and is touched when a user saves a connection or a resolution
 * happens — never in a loop — so a cache would buy nothing and would have to
 * be invalidated by a second Artemis window writing the same file.
 */
export function createSecretManagerCredentials(userDataDir: string): SecretManagerCredentials {
  const file = join(userDataDir, SECRETS_FILE);

  async function read(): Promise<SecretsDocument> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const document: SecretsDocument = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry['token'] !== 'string') continue;
        document[id] = {
          token: entry['token'],
          ...(typeof entry['expiresAt'] === 'number' ? { expiresAt: entry['expiresAt'] } : {}),
        };
      }
      return document;
    } catch (error) {
      // A missing file is the ordinary state — a machine with no key manager
      // configured has none. A corrupt one is reported and treated as empty:
      // refusing to start over a damaged credential file would take every
      // other connection with it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${SECRETS_FILE}; treating it as empty.`, error);
      }
      return {};
    }
  }

  async function write(document: SecretsDocument): Promise<void> {
    // Written to a sibling and renamed, so an interrupted write cannot leave a
    // truncated file that reads as "every connection lost its credential".
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    async read(connectionId: string): Promise<SecretManagerCredential | null> {
      const stored = (await read())[connectionId];
      if (stored === undefined) return null;
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn(`A credential is stored for '${connectionId}' but this session cannot decrypt it.`);
        return null;
      }
      try {
        return {
          token: safeStorage.decryptString(Buffer.from(stored.token, 'base64')),
          ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
        };
      } catch (error) {
        // A credential encrypted under a keychain entry that has since been
        // removed, or a file copied from another machine. Reported as absent,
        // because that is what it now is — the connection verifies as
        // unauthenticated and the pane asks for the password again.
        log.warn(`The stored credential for '${connectionId}' could not be decrypted.`, error);
        return null;
      }
    },

    async write(connectionId: string, credential: SecretManagerCredential): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'This system has no secure storage available, so the key manager’s credential cannot be saved.',
        );
      }
      const document = await read();
      document[connectionId] = {
        token: safeStorage.encryptString(credential.token).toString('base64'),
        ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
      };
      await write(document);
    },

    async clear(connectionId: string): Promise<void> {
      const document = await read();
      if (!(connectionId in document)) return;
      delete document[connectionId];
      // The last credential leaving takes the file with it, so an Artemis
      // holding no manager credentials has no credential file — which is a
      // thing a user can check for themselves.
      if (Object.keys(document).length === 0) {
        await unlink(file).catch(() => undefined);
        return;
      }
      await write(document);
    },

    async has(connectionId: string): Promise<boolean> {
      // Deliberately does not decrypt; see the interface.
      return connectionId in (await read());
    },
  };
}
