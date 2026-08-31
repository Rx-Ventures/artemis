import { describe, expect, it } from 'vitest';

import {
  chromiumSandboxVerdict,
  ozonePlatformHint,
  sandboxAlreadyDisabled,
  type LinuxSandboxFacts,
} from './linuxStartup';

/**
 * An unrestricted machine: no sysctl says no, no profile, no setuid helper.
 * Every case below is this with one fact changed, so what a test is about is
 * the line that differs from here.
 */
const UNRESTRICTED: LinuxSandboxFacts = {
  maxUserNamespaces: 15_000,
  unprivilegedUsernsClone: null,
  apparmorRestrictsUserns: null,
  apparmorProfileInstalled: false,
  helperIsSuidRoot: false,
};

const facts = (overrides: Partial<LinuxSandboxFacts>): LinuxSandboxFacts => ({
  ...UNRESTRICTED,
  ...overrides,
});

describe('chromiumSandboxVerdict', () => {
  it('keeps the sandbox when nothing says the machine restricts it', () => {
    expect(chromiumSandboxVerdict(UNRESTRICTED)).toEqual({ usable: true, reason: '' });
  });

  /*
   * The half of the interface that is easiest to get wrong. `unprivileged_userns_clone`
   * only exists on Debian-family kernels; on Fedora and Arch the file is simply
   * not there. Reading absence as zero would disable the sandbox on every
   * distro that never had the knob.
   */
  it('does not read an absent sysctl as a disabled one', () => {
    expect(
      chromiumSandboxVerdict(
        facts({ unprivilegedUsernsClone: null, apparmorRestrictsUserns: null }),
      ).usable,
    ).toBe(true);
  });

  it('gives up when the kernel allows no user namespaces at all', () => {
    const verdict = chromiumSandboxVerdict(facts({ maxUserNamespaces: 0 }));
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('user.max_user_namespaces');
  });

  it('gives up when the Debian knob is off', () => {
    const verdict = chromiumSandboxVerdict(facts({ unprivilegedUsernsClone: 0 }));
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('unprivileged_userns_clone');
  });

  /*
   * Ubuntu 24.04's default, and the case this preflight exists for: the
   * restriction is enforced by AppArmor rather than by a namespace sysctl, and
   * it exempts binaries that carry a profile. An installed deb has one — so the
   * package works and a build from source beside it does not, which is exactly
   * the pair a user reports as "it works for you and not for me".
   */
  it('gives up under the Ubuntu 24.04 AppArmor restriction with no profile', () => {
    const verdict = chromiumSandboxVerdict(facts({ apparmorRestrictsUserns: 1 }));
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toContain('AppArmor');
  });

  it('keeps the sandbox under that restriction when the profile is installed', () => {
    expect(
      chromiumSandboxVerdict(
        facts({ apparmorRestrictsUserns: 1, apparmorProfileInstalled: true }),
      ).usable,
    ).toBe(true);
  });

  /*
   * The setuid helper is unconditional: it is what the fpm packages' install
   * script sets precisely so that the kernel's opinion of user namespaces stops
   * mattering. Every restriction above must lose to it.
   */
  it('keeps the sandbox whenever chrome-sandbox is setuid root, whatever the kernel says', () => {
    for (const restriction of [
      { maxUserNamespaces: 0 },
      { unprivilegedUsernsClone: 0 },
      { apparmorRestrictsUserns: 1 },
    ]) {
      expect(chromiumSandboxVerdict(facts({ ...restriction, helperIsSuidRoot: true })).usable).toBe(
        true,
      );
    }
  });

  it('always explains a refusal and never explains a pass', () => {
    expect(chromiumSandboxVerdict(facts({ maxUserNamespaces: 0 })).reason.length).toBeGreaterThan(0);
    expect(chromiumSandboxVerdict(UNRESTRICTED).reason).toBe('');
  });
});

describe('sandboxAlreadyDisabled', () => {
  /*
   * electron-builder's AppImage AppRun probes with `unshare -Ur true` and adds
   * this itself before exec'ing the binary. Deciding again could only disagree.
   */
  it('sees the flag the AppImage AppRun adds', () => {
    expect(sandboxAlreadyDisabled(['/opt/Artemis/artemis', '--no-sandbox'])).toBe(true);
    expect(sandboxAlreadyDisabled(['/opt/Artemis/artemis'])).toBe(false);
  });
});

describe('ozonePlatformHint', () => {
  it('asks Electron to choose on Linux, and says nothing anywhere else', () => {
    expect(ozonePlatformHint('linux', [], {})).toBe('auto');
    expect(ozonePlatformHint('darwin', [], {})).toBeNull();
    expect(ozonePlatformHint('win32', [], {})).toBeNull();
  });

  /*
   * The way out for the driver and compositor pairings that have shipped
   * blank-window bugs under native Wayland. A user who hits one needs to be
   * able to say `--ozone-platform=x11` and be listened to.
   */
  it('defers to an explicit switch on the command line', () => {
    expect(ozonePlatformHint('linux', ['--ozone-platform=x11'], {})).toBeNull();
    expect(ozonePlatformHint('linux', ['--ozone-platform-hint=x11'], {})).toBeNull();
  });

  /*
   * Electron reads this variable itself. Appending a switch would take
   * precedence over it, which would make the documented escape hatch a lie.
   */
  it('defers to ELECTRON_OZONE_PLATFORM_HINT, which Electron reads on its own', () => {
    expect(ozonePlatformHint('linux', [], { ELECTRON_OZONE_PLATFORM_HINT: 'x11' })).toBeNull();
    expect(ozonePlatformHint('linux', [], { ELECTRON_OZONE_PLATFORM_HINT: '  ' })).toBe('auto');
    expect(ozonePlatformHint('linux', [], { ELECTRON_OZONE_PLATFORM_HINT: '' })).toBe('auto');
  });
});
