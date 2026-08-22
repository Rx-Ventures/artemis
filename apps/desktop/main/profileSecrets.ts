/**
 * The encrypted side of a local-server profile.
 * ============================================================================
 *
 * `core/profiles/secrets.ts` says why this key exists at all and what rules it
 * lives under; this is the half that needs Electron, and it is deliberately
 * small. One file, one JSON object, `profileId → base64 ciphertext`, written
 * `0600` beside `profiles.json` rather than inside it — that file is plain,
 * hand-editable, and its own tests assert there is no secret in it.
 *
 * ## What `safeStorage` gives, and what it does not
 *
 * On macOS the key lives in the login Keychain, so the ciphertext is readable
 * only by this app on this machine and by whoever can unlock that Keychain. It
 * is not a secret vault with an audit trail, and it is not proof against a
 * user's own account being compromised — it is the same protection Electron
 * gives every other app's stored token, which is the right bar for a key to a
 * server on the user's own desk.
 *
 * ## When encryption is unavailable
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no
 * keyring, and briefly false on any platform before `app.ready`. Writing the
 * key in clear at that point would be a silent downgrade from encrypted to
 * not, which is the failure mode a boundary must never have — so the write
 * fails loudly instead, and the editor reports that the key could not be
 * saved. A user who cannot store a key can still run a server without one.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { safeStorage } from 'electron';

import type { ProfileId } from '@rx-artemis/protocol';
import type { ProfileSecrets } from '@rx-artemis/core';

import { createLogger } from './log.js';

const log = createLogger('profile-secrets');

/** Beside `profiles.json`, and never inside it. */
const SECRETS_FILE = 'profile-keys.json';

/** What the file holds: one base64 ciphertext per profile that has a key. */
type SecretsDocument = Record<string, string>;

/**
 * A `safeStorage`-backed {@link ProfileSecrets}.
 *
 * Reads the whole document per call rather than caching it. The file holds one
 * short string per local profile and is touched when a user edits a profile or
 * starts a run — never in a loop — so a cache would buy nothing and would have
 * to be invalidated by a second Artemis window writing the same file.
 */
export function createProfileSecrets(userDataDir: string): ProfileSecrets {
  const file = join(userDataDir, SECRETS_FILE);

  async function read(): Promise<SecretsDocument> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const document: SecretsDocument = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') document[id] = value;
      }
      return document;
    } catch (error) {
      // A missing file is the ordinary state — most profiles have no key. A
      // corrupt one is reported and treated as empty: refusing to start over a
      // damaged key file would lock the user out of every other provider too.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${SECRETS_FILE}; treating it as empty.`, error);
      }
      return {};
    }
  }

  async function write(document: SecretsDocument): Promise<void> {
    // Written to a sibling and renamed, so an interrupted write cannot leave a
    // truncated file that reads as "every profile lost its key".
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  return {
    async read(id: ProfileId): Promise<string | null> {
      const stored = (await read())[id];
      if (stored === undefined) return null;
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('A key is stored but this session cannot decrypt it.');
        return null;
      }
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch (error) {
        // A key encrypted under a keychain entry that has since been removed,
        // or a file copied from another machine. Reported as absent, because
        // that is what it now is.
        log.warn('A stored key could not be decrypted.', error);
        return null;
      }
    },

    async write(id: ProfileId, secret: string): Promise<void> {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'This system has no secure storage available, so the key cannot be saved.',
        );
      }
      const document = await read();
      document[id] = safeStorage.encryptString(secret).toString('base64');
      await write(document);
    },

    async clear(id: ProfileId): Promise<void> {
      const document = await read();
      if (!(id in document)) return;
      delete document[id];
      // The last key leaving takes the file with it, so an Artemis with no
      // stored keys has no key file — which is a thing a user can check.
      if (Object.keys(document).length === 0) {
        await unlink(file).catch(() => undefined);
        return;
      }
      await write(document);
    },

    async has(id: ProfileId): Promise<boolean> {
      // Deliberately does not decrypt: this answers the editor's "is a key
      // set?", and putting the plaintext in memory to compute a boolean would
      // be work done for the sake of exposure.
      return id in (await read());
    },
  };
}
