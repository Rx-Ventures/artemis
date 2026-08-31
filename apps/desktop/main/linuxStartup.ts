/**
 * The switches a Linux machine needs before Electron initialises.
 * ============================================================================
 *
 * Two decisions, both of which must be made before `app.whenReady()` and
 * neither of which any other platform has to make. They live together because
 * they are the same shape — read something about *this* machine, and decide a
 * command-line switch from it — and because a reader looking for "why does
 * Artemis pass that flag on Linux" should find one file rather than two hooks
 * in `index.ts`.
 *
 * Split like `shellPath.ts` and `commandSandbox.ts`: the verdicts are pure and
 * take the facts as arguments, and one impure function goes and reads them.
 * That is what lets a Mac exercise the Ubuntu 24.04 case.
 *
 * ## Why the sandbox needs a preflight at all
 *
 * Chromium confines its renderers with one of two mechanisms, and on Linux it
 * needs the machine's permission for both. The modern one is an unprivileged
 * user namespace; the fallback is `chrome-sandbox`, a small setuid-root helper
 * shipped beside the executable. If neither is available Electron does not
 * degrade — it aborts, in the zygote, before a line of this app has run, with
 * `FATAL:setuid_sandbox_host.cc` and no window to say it in.
 *
 * For two of the three ways Artemis is installed, somebody else already
 * handles this. electron-builder's fpm `after-install` script chmods
 * `chrome-sandbox` to 4755 when it finds no user namespaces, and installs an
 * AppArmor profile on Ubuntu 24+; its AppImage `AppRun` probes with
 * `unshare -Ur true` and adds `--no-sandbox` itself. Neither covers the third
 * way, which is the one this repository tells people to use when their distro
 * has no package: a build from source, run out of `linux-unpacked` or
 * `electron-vite dev`, where `chrome-sandbox` is a plain 0755 file. On a
 * kernel that restricts unprivileged user namespaces — Ubuntu 24.04 and its
 * derivatives by default, Debian with `unprivileged_userns_clone=0`, most
 * hardened kernels — that build aborts on launch and says nothing a user can
 * act on.
 *
 * ## Why it is allowed to turn the sandbox off
 *
 * Because the alternative is not "a sandboxed Artemis", it is "no Artemis",
 * and because it says so out loud. This is deliberately *not* the reasoning
 * `commandSandbox.ts` refuses on Windows: there, running a model's command
 * unconfined is a new risk taken on the user's behalf without asking. Here the
 * renderer is Artemis's own code and the downgrade is one Chromium itself
 * offers, every other Electron app on the machine has already taken, and the
 * AppImage this repository ships takes automatically. The rule kept from that
 * file is the one that matters: never downgrade *silently*. The verdict below
 * carries the reason, `index.ts` logs it at warn level with the command that
 * fixes it, and the README documents both.
 *
 * The verdict only ever downgrades on positive evidence — a sysctl that says
 * restricted, or a helper that is present and not setuid root. A machine that
 * cannot be read about keeps its sandbox and takes its chances with Chromium's
 * own error, which is the safe direction to be wrong in.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/* -------------------------------------------------------------------------- */
/* The Chromium sandbox                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What this machine says about confining a renderer.
 *
 * Every sysctl is `number | null`, and `null` means the file is not there —
 * which is not the same as zero. `unprivileged_userns_clone` exists only on
 * Debian-family kernels and its absence means "no such restriction", while a
 * `0` in it means "namespaces are off". Collapsing the two is how you conclude
 * that Fedora forbids user namespaces.
 */
export interface LinuxSandboxFacts {
  /** `/proc/sys/user/max_user_namespaces` — 0 disables them outright. */
  readonly maxUserNamespaces: number | null;
  /** `/proc/sys/kernel/unprivileged_userns_clone` — Debian family; 0 disables. */
  readonly unprivilegedUsernsClone: number | null;
  /** `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` — Ubuntu 24.04+; 1 restricts. */
  readonly apparmorRestrictsUserns: number | null;
  /** Is there an AppArmor profile for this executable under `/etc/apparmor.d/`? */
  readonly apparmorProfileInstalled: boolean;
  /** Is `chrome-sandbox` beside the executable both setuid and owned by root? */
  readonly helperIsSuidRoot: boolean;
}

/** Whether the sandbox can start here, and — when it cannot — why not. */
export interface SandboxVerdict {
  readonly usable: boolean;
  /** Empty when usable. Otherwise one sentence naming the restriction. */
  readonly reason: string;
}

/**
 * Can Chromium's Linux sandbox start on a machine with these facts?
 *
 * The setuid helper is checked first because it is unconditional: a
 * `chrome-sandbox` that is setuid root works whatever the kernel thinks of
 * user namespaces, which is exactly why the fpm packages set that bit.
 */
export function chromiumSandboxVerdict(facts: LinuxSandboxFacts): SandboxVerdict {
  if (facts.helperIsSuidRoot) return { usable: true, reason: '' };

  if (facts.maxUserNamespaces === 0) {
    return {
      usable: false,
      reason:
        'this kernel sets user.max_user_namespaces to 0, so no unprivileged process can ' +
        'create the namespace the sandbox is built on, and chrome-sandbox is not setuid root',
    };
  }

  if (facts.unprivilegedUsernsClone === 0) {
    return {
      usable: false,
      reason:
        'this kernel sets kernel.unprivileged_userns_clone to 0, so unprivileged user ' +
        'namespaces are disabled, and chrome-sandbox is not setuid root',
    };
  }

  // Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor rather
  // than through a namespace sysctl, and exempts binaries that carry a profile.
  // electron-builder's deb installs one, so a packaged install is exempt and an
  // unpacked build beside it is not — the whole reason this case is separate.
  if (facts.apparmorRestrictsUserns === 1 && !facts.apparmorProfileInstalled) {
    return {
      usable: false,
      reason:
        'AppArmor restricts unprivileged user namespaces here (Ubuntu 24.04 and later do ' +
        'this by default) and no AppArmor profile is installed for this build, which is ' +
        'expected for a build from source rather than an installed package',
    };
  }

  return { usable: true, reason: '' };
}

/** Read {@link LinuxSandboxFacts} off this machine. */
export function readLinuxSandboxFacts(executablePath: string): LinuxSandboxFacts {
  const sysctl = (path: string): number | null => {
    try {
      const parsed = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      // Absent is a fact, and a different one from zero. See the interface.
      return null;
    }
  };

  let helperIsSuidRoot = false;
  try {
    const helper = statSync(join(dirname(executablePath), 'chrome-sandbox'));
    // Both halves, and `uid === 0` is the half that matters: a setuid bit on a
    // file owned by the user grants the user's own privileges, which is to say
    // nothing, and Chromium refuses it anyway.
    helperIsSuidRoot = (helper.mode & 0o4000) !== 0 && helper.uid === 0;
  } catch {
    // No helper beside the binary: dev runs and unusual layouts both land here.
  }

  return {
    maxUserNamespaces: sysctl('/proc/sys/user/max_user_namespaces'),
    unprivilegedUsernsClone: sysctl('/proc/sys/kernel/unprivileged_userns_clone'),
    apparmorRestrictsUserns: sysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    // The path electron-builder's after-install script writes to.
    apparmorProfileInstalled: existsSync(join('/etc/apparmor.d', basename(executablePath))),
    helperIsSuidRoot,
  };
}

/* -------------------------------------------------------------------------- */
/* Ozone: which display server to talk to                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether to ask Electron to pick a display backend, and why it is not simply
 * always passed.
 *
 * Without a hint Electron talks X11 unconditionally, so on a Wayland session —
 * the default on Fedora, on SteamOS's desktop mode, and on current GNOME and
 * KDE — Artemis runs through XWayland. That is not a crash, it is a slow leak
 * of quality: XWayland cannot do fractional scaling, so the whole window is
 * rendered at an integer factor and resampled, and every glyph in the app is
 * soft on the 125% and 150% displays those desktops ship configured for.
 *
 * `auto` rather than `wayland`, because the hint has to be right on X11 too and
 * `auto` is Electron's own "Wayland if there is one, X11 otherwise".
 *
 * Two ways to say no, both honoured, because there is one real reason to: some
 * driver and compositor pairings — proprietary NVIDIA especially — have shipped
 * blank-window bugs under native Wayland, and a user who hits one needs a way
 * back that does not involve a new build. An explicit `--ozone-platform` or
 * `--ozone-platform-hint` in argv wins, and so does `ELECTRON_OZONE_PLATFORM_HINT`,
 * which Electron reads by itself and which appending a switch would override.
 */
export function ozonePlatformHint(
  platform: NodeJS.Platform,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== 'linux') return null;
  if (argv.some((arg) => arg.startsWith('--ozone-platform'))) return null;
  const declared = env['ELECTRON_OZONE_PLATFORM_HINT'];
  if (declared !== undefined && declared.trim() !== '') return null;
  return 'auto';
}

/* -------------------------------------------------------------------------- */
/* Argv                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Has somebody already turned the sandbox off?
 *
 * The AppImage's `AppRun` does exactly this before exec'ing the binary, and a
 * user debugging a launch does it by hand. Either way the work below is done
 * and re-deciding it would only risk disagreeing.
 */
export function sandboxAlreadyDisabled(argv: readonly string[]): boolean {
  return argv.includes('--no-sandbox');
}
