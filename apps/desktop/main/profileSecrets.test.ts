import { describe, expect, it } from 'vitest';

import { backendEncrypts } from './profileSecrets';

/**
 * The backend names are Chromium's, spelled as `safeStorage.getSelectedStorageBackend()`
 * returns them. Listed rather than reduced to "not basic_text" so that a new
 * backend appearing in Electron shows up here as a decision somebody made.
 */
const REAL_BACKENDS = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const;

describe('backendEncrypts', () => {
  it('accepts every backend that talks to a real keyring', () => {
    for (const backend of REAL_BACKENDS) {
      expect(backendEncrypts('linux', backend)).toBe(true);
    }
  });

  /*
   * The bug. `basic_text` uses a password compiled into Chromium, so anyone
   * holding the file can undo it — and `isEncryptionAvailable()` reports true
   * for it, because a cipher does run. Chromium selects it whenever it does not
   * recognise the desktop environment, which is every tiling compositor and so
   * a large share of the Arch and CachyOS machines this is meant to run on.
   */
  it('refuses basic_text, whose password is compiled into Chromium', () => {
    expect(backendEncrypts('linux', 'basic_text')).toBe(false);
  });

  /*
   * What the API returns before `app.ready`. `isEncryptionAvailable()` is
   * independently false at that point and the two are `&&`-ed, so the honest
   * answer for a backend nobody has selected yet is "no evidence it is weak".
   */
  it('does not condemn a backend that has not been selected yet', () => {
    expect(backendEncrypts('linux', 'unknown')).toBe(true);
  });

  /*
   * There is no backend to ask about off Linux: macOS is the login Keychain and
   * Windows is DPAPI. Neither has a basic_text equivalent, and neither would
   * survive this predicate returning false for a name it does not know.
   */
  it('leaves macOS and Windows to isEncryptionAvailable alone', () => {
    expect(backendEncrypts('darwin', 'basic_text')).toBe(true);
    expect(backendEncrypts('win32', 'basic_text')).toBe(true);
  });
});
