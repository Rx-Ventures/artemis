/**
 * Give the bundle's two shipped executables their executable bit.
 * ============================================================================
 *
 * Two files, one problem, one moment to fix it. node-pty's `spawn-helper` is
 * the original case and the long explanation below is about it; the banks' CLI
 * (`resources/cerebro`) is the same story in fewer words. It is an
 * extension-less Python script whose first line is a shebang, which is how it
 * is run everywhere except Windows — and a shebang without an execute bit is
 * decoration. It reaches the packager as whatever mode the checkout gave it,
 * which on a Windows build host is `0644`, and a macOS or Linux user then
 * installs a memory-bank CLI they cannot run.
 *
 * Only the helper is required to exist: a build with no `cerebro` resource is
 * a build without the banks, which is a configuration rather than a fault.
 *
 * On macOS and Linux node-pty spawns a shell by exec'ing a small helper binary
 * that sets up the controlling terminal first. The published node-pty tarball
 * ships that helper as `0644` — no execute bit for anyone — and every step
 * between npm and a user's machine faithfully preserves it: `asarUnpack`
 * extracts it into `app.asar.unpacked` with the mode it had, the dmg and the
 * zip carry the mode through, and the install arrives unable to exec the one
 * file it must. The failure is `posix_spawnp failed`, raised at the moment
 * somebody opens a terminal and naming neither the file nor the permission.
 *
 * Setting the bit here — after the app directory is packed, before it is signed
 * and long before it is compressed — is what makes it true for everyone who
 * installs the result.
 *
 * ## Why the app cannot do this to itself
 *
 * It tries, and should: `main/terminal.ts` chmods the helper on first use, and
 * that is what repairs a checkout. But an app cannot chmod a file it does not
 * own, and a released one frequently does not own itself — installed into
 * `/Applications` by an admin and run by a standard user, deployed read-only by
 * MDM, or simply run off the mounted dmg without being copied out at all. In
 * every one of those the runtime repair fails and the terminal stays broken.
 * Package time is the last moment the file is reliably writable.
 *
 * `chmod` does not invalidate a code signature — a signature covers contents,
 * not inode mode — and electron-builder runs this hook before signing anyway.
 *
 * ## Why it throws
 *
 * A hook that shrugs when it finds nothing is how the previous version of this
 * fix failed: it repaired the wrong path, said nothing about it, and shipped.
 * On a platform that needs a helper, finding none means node-pty moved it, or
 * `asarUnpack` stopped covering node-pty, or the resources directory is not
 * where it was — each of which ships a build whose terminal cannot start. That
 * is worth failing a release over, and the release workflow re-checks the
 * finished bundle in `scripts/verify-package.ts` in case this is ever skipped.
 */

const { chmod, readdir, stat } = require('node:fs/promises');
const path = require('node:path');

/** node-pty's helper, by the only name it has ever had. */
const HELPER = 'spawn-helper';

/**
 * The banks' CLI, as `extraResources` places it — beside `app.asar` rather
 * than inside it, because a file that has to be *spawned* cannot live in an
 * archive. `main/memoryBanks.ts` looks for it at exactly this path.
 */
const CEREBRO = 'cerebro';

/**
 * Every plausible home for the helper inside the unpacked node-pty.
 *
 * `prebuilds/<platform>-<arch>/` is what a prebuilt install produces, and the
 * package contains one directory per platform it publishes — all of them are
 * chmodded rather than just the host's, because it costs a `stat` and it means
 * a future cross-build does not quietly reintroduce this. `build/Release/` is
 * what node-gyp writes when it compiled locally instead.
 */
async function helperPaths(ptyRoot) {
  const found = [];

  const prebuilds = path.join(ptyRoot, 'prebuilds');
  let entries = [];
  try {
    entries = await readdir(prebuilds, { withFileTypes: true });
  } catch {
    // No prebuilds directory: a locally compiled node-pty. `build/Release`
    // below is where that one puts it.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(path.join(prebuilds, entry.name, HELPER));
  }

  found.push(path.join(ptyRoot, 'build', 'Release', HELPER));

  const present = [];
  for (const candidate of found) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) present.push(candidate);
    } catch {
      // A layout that is not present is the common case, not an error.
    }
  }
  return present;
}

/** @type {(context: import('electron-builder').AfterPackContext) => Promise<void>} */
module.exports = async function afterPack(context) {
  // Windows drives the PTY through ConPTY and has no helper to chmod — and no
  // execute bit to set if it did.
  if (context.electronPlatformName === 'win32') return;

  const resources = context.packager.getResourcesDir(context.appOutDir);
  const ptyRoot = path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty');

  const helpers = await helperPaths(ptyRoot);
  if (helpers.length === 0) {
    throw new Error(
      `after-pack: no ${HELPER} under ${ptyRoot}. node-pty needs one on ` +
        `${context.electronPlatformName} to spawn anything, so this build's terminal ` +
        'would fail with "posix_spawnp failed". Check that asarUnpack still covers ' +
        'node-pty and that the prebuilds layout has not moved.',
    );
  }

  for (const helper of helpers) {
    await chmod(helper, 0o755);
    console.log(`  • after-pack: chmod 0755 ${path.relative(context.appOutDir, helper)}`);
  }

  // The banks' CLI. Not fatal when absent — see the header — but noted either
  // way, so a build that quietly stopped shipping it says so in its log.
  const cli = path.join(resources, CEREBRO);
  try {
    const info = await stat(cli);
    if (info.isFile()) {
      await chmod(cli, 0o755);
      console.log(`  • after-pack: chmod 0755 ${path.relative(context.appOutDir, cli)}`);
    }
  } catch {
    console.log(`  • after-pack: no ${CEREBRO} resource in this build; nothing to chmod`);
  }
};
