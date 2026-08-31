/**
 * Finding the Claude Agent SDK's `claude` binary inside a packaged app.
 * ============================================================================
 *
 * The SDK is a JavaScript package plus one optional dependency per platform —
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` — holding the executable.
 * pnpm installs only the host's, which is what makes the release workflow's
 * "one runner per target" rule load-bearing.
 *
 * Two things go wrong without this module, and they are unrelated.
 *
 * **The asar.** The SDK resolves its platform package relative to its own
 * module, which in a packaged app is a virtual `app.asar/...` path — readable
 * through Electron's patched `fs`, but not spawnable, because
 * `child_process.spawn` is not patched and the raw syscall hits `app.asar` (a
 * file) as a path component and fails with `ENOTDIR`. Both the SDK and its
 * platform package ship under `app.asar.unpacked` (see `asarUnpack` in
 * electron-builder.yml), and this finds the binary there so the engine can hand
 * the SDK a path that exists on the actual filesystem.
 *
 * **The C library.** Linux is the one platform where "platform and arch" does
 * not name a single binary: the SDK publishes a `-musl` variant per
 * architecture beside the glibc one, and on an Alpine base image or any other
 * musl host that variant is the only one pnpm installs. A lookup for the exact
 * `linux-x64` name finds nothing there and the engine starts with no
 * executable path — so the SDK falls back to its own asar-relative resolution
 * and dies on the `ENOTDIR` above.
 *
 * `scripts/verify-package.ts` has accepted either name since it was written;
 * this is the same knowledge on the runtime side, where it had been missing.
 * The two are deliberately not shared: that script runs under plain Node in
 * CI and this runs inside Electron, and one import across that line would drag
 * a release gate into the app bundle.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The SDK platform packages that can satisfy this host, best first.
 *
 * Exact before musl, because on a glibc host the exact name is what pnpm
 * installed and there is no reason to stat a directory that will not be there.
 * Only Linux gets a second candidate — macOS and Windows have one C library
 * each as far as this package is concerned.
 */
export function sdkPackageNames(platform: NodeJS.Platform, arch: string): readonly string[] {
  const exact = `claude-agent-sdk-${platform}-${arch}`;
  return platform === 'linux' ? [exact, `${exact}-musl`] : [exact];
}

/** The executable's name inside the platform package, per platform. */
export function sdkExecutableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['claude.exe'] : ['claude'];
}

/**
 * The bundled `claude` binary at its real on-disk path, or undefined.
 *
 * `resourcesPath` is null in development, where there is no asar and the SDK's
 * own resolution is already correct. Undefined is also the answer when the
 * binary is missing: the SDK then fails with its own message, which names the
 * real problem instead of the misleading ENOTDIR.
 */
export function bundledSdkExecutablePath(
  resourcesPath: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  readdir: (path: string) => readonly string[] = readdirSync,
): string | undefined {
  if (resourcesPath === null) return undefined;

  const executables = sdkExecutableNames(platform);
  for (const packageName of sdkPackageNames(platform, arch)) {
    const packageDir = join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      packageName,
    );
    let entries: readonly string[];
    try {
      entries = readdir(packageDir);
    } catch {
      // The package for the other C library, or no package at all. Both are
      // ordinary here — only finding none of them is news, and the caller's
      // undefined is how that gets said.
      continue;
    }
    const binary = entries.find((name) => executables.includes(name));
    if (binary !== undefined) return join(packageDir, binary);
  }
  return undefined;
}
