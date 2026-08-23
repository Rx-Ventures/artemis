/**
 * Profile keys, stored as a file — the headless stand-in for `safeStorage`.
 *
 * The desktop app encrypts local-profile API keys with the OS keychain
 * (`profileSecrets.ts` there). A container has no keychain, and inventing a
 * passphrase dance for a server that also mounts the *provider config
 * directories in plaintext* would be security theatre: whoever can read
 * `/data` already holds the Claude OAuth credentials beside this file. So the
 * honest design is the one the providers themselves use — a `0600` file in
 * the data directory, protected by the same thing everything in it is
 * protected by: filesystem permissions and whatever encrypts the volume.
 *
 * Same file name and shape as the desktop's (`profile-keys.json`,
 * `profileId → value`), except the values are plain rather than ciphertext —
 * a data directory is either the desktop's or a server's, never both, so the
 * two implementations never read each other's files.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ProfileSecrets } from '@rx-artemis/core';

const SECRETS_FILE = 'profile-keys.json';

export function createFileProfileSecrets(dataDir: string): ProfileSecrets {
  const file = join(dataDir, SECRETS_FILE);

  async function read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function write(document: Record<string, string>): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  return {
    async read(id) {
      return (await read())[String(id)] ?? null;
    },
    async write(id, secret) {
      const document = await read();
      document[String(id)] = secret;
      await write(document);
    },
    async clear(id) {
      const document = await read();
      if (!(String(id) in document)) return;
      delete document[String(id)];
      if (Object.keys(document).length === 0) {
        await unlink(file).catch(() => undefined);
        return;
      }
      await write(document);
    },
    async has(id) {
      return String(id) in (await read());
    },
  };
}
