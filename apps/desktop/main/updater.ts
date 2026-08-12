/**
 * The updater: finds a newer release, fetches it, verifies it, swaps the app
 * bundle in place, and relaunches.
 *
 * ## Why not electron-updater
 *
 * Artemis ships unsigned — an internal decision, documented in the release
 * notes — and electron-updater's macOS path hard-requires a signed app: its
 * embedded Squirrel.Mac validates the code signature of the downloaded update
 * against the running app and refuses ad-hoc builds. So the mechanism here is
 * the plain one: download the zip electron-builder already publishes, check
 * its sha512 against the feed, `ditto`-extract, rename the old bundle aside,
 * rename the new one in, relaunch. Every step before the swap leaves the
 * installed app untouched, and the swap itself is two renames on one volume
 * with a rollback.
 *
 * ## Where the releases live, and how they are reached
 *
 * Releases sit on the same GitHub repository this build was published from
 * (`electron-builder.yml`'s `publish` block, `scripts/release.ts`), and that
 * repository is public. So the ordering here is the reverse of what it was:
 *
 *   1. Anonymous HTTPS against the public release URLs. No credential, no
 *      tooling, no account — every machine that can reach github.com can
 *      update, which is the whole dividend of going public.
 *   2. `gh release download` with the user's own GitHub CLI login, when a
 *      usable `gh` exists. No longer the route that grants *access*, only a
 *      second way through: a proxy that mangles the CDN redirect, a transient
 *      5xx, an enterprise network that trusts `gh` and not much else.
 *
 * While the repository was private these were the other way around, because
 * private meant authenticated and Artemis holds no credentials — the same
 * answer as `claude auth login`: the user's own tooling holds the credential.
 * That is still true, and now nothing needs to hold one. No token is stored,
 * asked for, or accepted. A machine with neither route simply never sees a
 * banner, and the release notes remain the manual path.
 *
 * ## What the renderer sees
 *
 * One {@link UpdateState}, pushed on every change. No URL, no path, no
 * checksum crosses the IPC boundary — the renderer's whole vocabulary is
 * "there is a version", "install it", "not this one".
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, createWriteStream } from 'node:fs';
// No `rm`: removing a tree that can hold an app bundle goes through
// `removeTree` below, for a reason documented there.
import { mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { app } from 'electron';
import type { UpdateState } from '@rx-artemis/protocol';

import { createLogger } from './log.js';
import { parseUpdateFeed, shouldOffer, type UpdateFeed } from './updateFeed.js';

const execFileAsync = promisify(execFile);

const log = createLogger('updater');

/**
 * The repository releases are published to. Kept in lockstep with the
 * `publish` block in `apps/desktop/electron-builder.yml` by hand — there is no
 * runtime accessor for the builder's config, the same situation as `appId`.
 */
const REPO = 'Rx-Ventures/artemis';
const RELEASES_URL = `https://github.com/${REPO}/releases`;

/**
 * The feed for *this* machine. Releases carry one feed per mac architecture
 * (CI renames electron-builder's `latest-mac.yml` per build — see
 * `.github/workflows/release.yml`), because a feed's top-level `path` is the
 * artifact to install and an Intel Mac must never be handed the arm64 zip.
 */
const FEED_NAME = `latest-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.yml`;

/** First check shortly after launch; then steadily. Both deliberately lazy —
 * an update is never urgent enough to compete with startup. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** Where `gh` tends to live when a GUI launch doesn't inherit the shell's PATH. */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

/**
 * What one check found — the answer to a question somebody asked out loud.
 *
 * The periodic check does not need this: finding nothing is the overwhelmingly
 * common case and the right response to it is silence, which is why `check`
 * used to return `void`. A person who chooses *Check for Updates…* has asked a
 * question, and every one of these outcomes is an answer they are owed,
 * including the three that leave the screen exactly as it was.
 */
export type CheckOutcome =
  /** Something newer exists; the state is now `available` and the card is up. */
  | { readonly kind: 'offered'; readonly version: string }
  /** The feed was read and this build is not behind it. */
  | { readonly kind: 'current' }
  /** No `gh`, no network, no access. Indistinguishable from here, and the same advice. */
  | { readonly kind: 'unreachable' }
  /** An offer, install or restart is already under way; the card is already saying so. */
  | { readonly kind: 'busy' }
  /** Nothing a check could act on: a dev build, or a platform the swap is not written for. */
  | { readonly kind: 'unsupported' };

export interface Updater {
  /** The state right now, for the pull channel. */
  state(): UpdateState;
  /**
   * Check now, because someone asked, and say what was found.
   *
   * Differs from the periodic check in three ways, all of them following from
   * the question having been asked deliberately: a version the user dismissed
   * is offered again (choosing to ask is the opposite of having declined), a
   * failed check is a state worth leaving so `error` is a valid phase to check
   * from, and the outcome comes back to the caller instead of only ever
   * reaching the screen when it is good news.
   */
  checkNow(): Promise<CheckOutcome>;
  /** Begin download → verify → swap, parking at `ready`. Resolves once underway. */
  install(): UpdateState;
  /** Relaunch into an installed update. A read unless the phase is `ready`. */
  restart(): UpdateState;
  /** Silence one version. */
  dismiss(version: string): Promise<UpdateState>;
  /** Start the periodic check. Idempotent. */
  start(): void;
  /** Stop checking and drop timers. */
  stop(): void;
}

export interface UpdaterOptions {
  readonly userDataDir: string;
  /** Push one state at every open window. Wired to the IPC broadcast. */
  readonly broadcast: (state: UpdateState) => void;
}

/**
 * Delete a directory tree, through `/bin/rm` rather than `fs.rm`.
 *
 * ## Not `fs.rm`, and not as a matter of taste
 *
 * Electron patches `fs` so that an `.asar` archive is transparently a
 * *directory*. Every tree this module removes can contain one — a parked app
 * bundle and the staging directory both hold `Contents/Resources/app.asar` —
 * so a recursive `fs.rm` descends *into* the archive rather than unlinking it,
 * cannot empty the directory it believes it is looking at, and fails with
 * `ENOTEMPTY`. `force: true` does not cover that: it swallows `ENOENT` only.
 *
 * What shipped, from the updater's first release through 0.5.0, was therefore a
 * husk of exactly one file — `Contents/Resources/app.asar`, around 6.5MB — left
 * in /Applications by every self-update, and another in the temp directory.
 *
 * `process.noAsar = true` fixes it too, and is worse here: it is a
 * process-global flag, so holding it across an `await` disables asar resolution
 * for everything else in the main process, including a window loading its
 * renderer entry from inside `app.asar`. `/bin/rm` holds no opinion about asar,
 * is the idiom `ditto` and `gh` above already establish for this module, and
 * exists on the only platform the updater runs on.
 *
 * Used for every tree here, including the one that holds nothing but a feed
 * file. "Which of these can contain an .asar?" is the question that produced
 * the bug, and it is better not to leave it standing.
 */
async function removeTree(path: string): Promise<void> {
  await execFileAsync('/bin/rm', ['-rf', path], { timeout: 5 * 60 * 1000 });
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { userDataDir, broadcast } = options;
  const settingsPath = join(userDataDir, 'update-settings.json');

  let current: UpdateState = IDLE;
  /** The feed behind an `available` offer; cleared whenever the offer is. */
  let offered: UpdateFeed | null = null;
  let installing = false;
  /** A check is in flight. Serialises the timer's against the menu's. */
  let checking = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function setState(next: UpdateState): UpdateState {
    current = next;
    broadcast(next);
    return next;
  }

  /* ----------------------------------------------------------------------- */
  /* Dismissal persistence                                                   */
  /* ----------------------------------------------------------------------- */

  async function readDismissed(): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      const value = (parsed as { dismissedVersion?: unknown }).dismissedVersion;
      return typeof value === 'string' ? value : null;
    } catch {
      return null; // No file yet, or unreadable — both mean "nothing dismissed".
    }
  }

  async function writeDismissed(version: string): Promise<void> {
    try {
      await writeFile(settingsPath, `${JSON.stringify({ dismissedVersion: version }, null, 2)}\n`);
    } catch (error) {
      // Losing a dismissal re-shows a banner; not worth surfacing beyond a log.
      log.warn('Could not persist the dismissed version.', error);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Reaching the release                                                    */
  /* ----------------------------------------------------------------------- */

  /** An executable `gh`, from PATH or the usual homes, or null. */
  function resolveGh(): string | null {
    const fromPath = (process.env['PATH'] ?? '').split(delimiter);
    for (const dir of [...fromPath, ...EXTRA_BIN_DIRS]) {
      if (dir === '') continue;
      const candidate = join(dir, 'gh');
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
    return null;
  }

  /** Env for `gh`, with PATH widened so its own helpers resolve under a GUI launch. */
  function ghEnv(): NodeJS.ProcessEnv {
    const path = [process.env['PATH'] ?? '', ...EXTRA_BIN_DIRS].filter(Boolean).join(delimiter);
    return { ...process.env, PATH: path };
  }

  /**
   * Download one release asset into `dir`: the public URL first, `gh` as the
   * fallback. `tag` is empty for "latest release".
   *
   * Both routes are tried for every asset, so a feed read and a 196MB zip take
   * the same path and a failure in the first is never fatal on its own — see the
   * file header for why the anonymous route leads now.
   */
  async function fetchAsset(name: string, tag: string, dir: string): Promise<string> {
    const destination = join(dir, name);
    const url =
      tag === ''
        ? `${RELEASES_URL}/latest/download/${name}`
        : `${RELEASES_URL}/download/${tag}/${name}`;
    try {
      await fetchAnonymously(url, destination);
      return destination;
    } catch (error) {
      const gh = resolveGh();
      if (gh === null) throw error;
      // Worth a line: a machine that quietly updates through `gh` every time is
      // a machine whose plain HTTPS route is broken, and nothing else would say
      // so until the day `gh` is uninstalled.
      log.debug(`Anonymous download of ${name} failed; falling back to gh.`, error);
      const args = ['release', 'download'];
      if (tag !== '') args.push(tag);
      args.push('-R', REPO, '-p', name, '-D', dir, '--clobber');
      await execFileAsync(gh, args, { env: ghEnv(), timeout: 10 * 60 * 1000 });
      return destination;
    }
  }

  /**
   * GET `url` to `destination`, streamed.
   *
   * Streamed and not `Buffer.from(await response.arrayBuffer())`, which is what
   * this was while it was dead code behind the `gh` route. The largest thing it
   * fetched then was a 500-byte feed; the largest thing it fetches now is the
   * release zip, which is around 196MB and would otherwise be held in the
   * privileged process's heap in one piece — twice over, for the moment the
   * Buffer copy and the ArrayBuffer both exist — before a byte reached disk.
   */
  async function fetchAnonymously(url: string, destination: string): Promise<void> {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    if (response.body === null) throw new Error(`GET ${url} answered without a body`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  }

  /* ----------------------------------------------------------------------- */
  /* The periodic check                                                      */
  /* ----------------------------------------------------------------------- */

  /**
   * Is there anything a check could lead to?
   *
   * The same two conditions `start()` refuses to run under, named once so the
   * menu's answer and the timer's silence cannot drift apart. A check that
   * cannot end in an install is not worth performing: it would read the feed,
   * find a newer version, offer it, and fail at the swap.
   */
  function supported(): boolean {
    return process.platform === 'darwin' && app.isPackaged;
  }

  async function check(options: { readonly manual: boolean }): Promise<CheckOutcome> {
    // Never check over an active offer or install: an offer mid-download must
    // not be replaced under the banner's feet. A manual check may leave an
    // `error` behind, though — retrying is the whole reason to ask again.
    if (checking || installing) return { kind: 'busy' };
    if (current.phase !== 'idle' && !(options.manual && current.phase === 'error')) {
      return current.phase === 'available' && current.version !== null
        ? { kind: 'offered', version: current.version }
        : { kind: 'busy' };
    }
    if (!supported()) return { kind: 'unsupported' };

    checking = true;
    try {
      let feed: UpdateFeed | null = null;
      try {
        const dir = await mkdtemp(join(tmpdir(), 'artemis-update-check-'));
        try {
          feed = parseUpdateFeed(await readFile(await fetchAsset(FEED_NAME, '', dir), 'utf8'));
        } finally {
          await removeTree(dir);
        }
      } catch (error) {
        // No gh, no network, no access: all mean "no banner today", not an error
        // surface. The manual path (the releases page) always remains.
        log.debug('Update check did not reach the feed.', error);
        return { kind: 'unreachable' };
      }
      if (feed === null) {
        log.warn('The update feed did not parse; staying quiet.');
        return { kind: 'unreachable' };
      }
      // A dismissal silences the timer, not the person asking: choosing to
      // check is the opposite of having declined, and re-offering is the only
      // way back to a version dismissed by accident.
      const dismissed = options.manual ? null : await readDismissed();
      if (!shouldOffer({ feedVersion: feed.version, currentVersion: app.getVersion(), dismissedVersion: dismissed })) {
        return { kind: 'current' };
      }
      offered = feed;
      log.info(`Update available: ${feed.version} (running ${app.getVersion()}).`);
      setState({ phase: 'available', version: feed.version, message: null, releaseUrl: null });
      return { kind: 'offered', version: feed.version };
    } finally {
      checking = false;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Install                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * The bundle this process is running out of, or null when there is nothing
   * a rename can update: not packaged, not laid out as an .app, or running
   * from a Gatekeeper app-translocation mount (read-only, and not the copy
   * the user keeps).
   */
  function swappableBundle(): string | null {
    if (!app.isPackaged) return null;
    // …/Artemis.app/Contents/MacOS/Artemis → …/Artemis.app
    const bundle = resolve(process.execPath, '..', '..', '..');
    if (!bundle.endsWith('.app')) return null;
    if (bundle.includes('/AppTranslocation/')) return null;
    try {
      accessSync(dirname(bundle), fsConstants.W_OK);
    } catch {
      return null;
    }
    return bundle;
  }

  async function sha512Of(file: string): Promise<string> {
    return createHash('sha512')
      .update(await readFile(file))
      .digest('base64');
  }

  async function runInstall(feed: UpdateFeed, bundle: string): Promise<void> {
    const staging = await mkdtemp(join(tmpdir(), 'artemis-update-'));
    try {
      const zip = await fetchAsset(feed.zipPath, `v${feed.version}`, staging);

      const digest = await sha512Of(zip);
      if (digest !== feed.sha512) {
        throw new Error('the downloaded archive did not match the published checksum');
      }

      const extracted = join(staging, 'extracted');
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', zip, extracted], {
        timeout: 5 * 60 * 1000,
      });
      const entries = await readdir(extracted);
      const appName = entries.find((entry) => entry.endsWith('.app'));
      if (appName === undefined) throw new Error('the archive did not contain an app bundle');
      const newBundle = join(extracted, appName);

      // The swap. Two renames on one volume; the first is undone if the
      // second cannot happen. From here on the failure modes are narrow and
      // the running process keeps executing fine from its renamed bundle —
      // open files follow the inode, not the path.
      const parked = `${bundle}.old-${process.pid}`;
      await rename(bundle, parked);
      try {
        await rename(newBundle, bundle);
      } catch (error) {
        await rename(parked, bundle);
        throw error;
      }

      // Park. The new version is on disk and the old one is what is running —
      // a state that is entirely fine to stay in: quitting normally from here
      // launches into the update anyway. The relaunch belongs to the user's
      // click on the banner (updates.restart), never to this code path.
      setState({ phase: 'ready', version: feed.version, message: null, releaseUrl: null });
      log.info(`Updated to ${feed.version} on disk; waiting for the user to restart.`);
    } finally {
      // The staging tree holds the extracted bundle, asar and all — see
      // `removeTree`. Left as a `.catch`: the install itself has either
      // succeeded or reported, and neither outcome changes over a temp file.
      await removeTree(staging).catch((error: unknown) => {
        log.warn('Could not clear the update staging directory.', error);
      });
    }
  }

  /** Remove bundles a previous update parked beside the app. */
  async function sweepParkedBundles(): Promise<void> {
    const bundle = swappableBundle();
    if (bundle === null) return;
    const parent = dirname(bundle);
    try {
      for (const entry of await readdir(parent)) {
        if (/\.app\.old-\d+$/.test(entry)) {
          await removeTree(join(parent, entry));
          log.info(`Removed a parked previous version: ${entry}`);
        }
      }
    } catch (error) {
      // Still costs disk space and nothing else. It is reported now because
      // saying nothing is what let this fail on every launch from the updater's
      // first release to 0.5.0 without anyone learning it was failing.
      log.warn('Could not remove a parked previous version.', error);
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The surface                                                             */
  /* ----------------------------------------------------------------------- */

  return {
    state: () => current,

    checkNow: () => check({ manual: true }),

    install(): UpdateState {
      if (current.phase !== 'available' || offered === null || installing) return current;
      const feed = offered;
      const bundle = swappableBundle();
      if (bundle === null) {
        // Nothing in-place to swap (translocated, or an unwritable location).
        // Say so once and hand over the manual path.
        return setState({
          phase: 'error',
          version: feed.version,
          message: 'This copy of Artemis cannot update itself. Download the new version from the releases page and replace the app.',
          releaseUrl: RELEASES_URL,
        });
      }
      installing = true;
      setState({ phase: 'working', version: feed.version, message: null, releaseUrl: null });
      void runInstall(feed, bundle)
        .catch((error: unknown) => {
          log.error('Update failed; the installed app is untouched.', error);
          setState({
            phase: 'error',
            version: feed.version,
            message: 'The update could not be installed. The app you are running is untouched — try again later, or download it from the releases page.',
            releaseUrl: RELEASES_URL,
          });
        })
        .finally(() => {
          installing = false;
        });
      return current;
    },

    restart(): UpdateState {
      if (current.phase !== 'ready') return current;
      setState({ phase: 'restarting', version: current.version, message: null, releaseUrl: null });
      log.info('Restarting into the installed update at the user\'s request.');
      // The parked old bundle is swept by the next launch's start(), not here:
      // this process is still running out of it.
      app.relaunch();
      app.quit();
      return current;
    },

    async dismiss(version: string): Promise<UpdateState> {
      await writeDismissed(version);
      // Only a decision that is still open can be dismissed. `ready` is
      // deliberately not dismissible: the update is already on disk, so the
      // honest states are "restart now" and "it arrives on your next launch" —
      // hiding the banner cannot un-install anything.
      if (current.version === version && (current.phase === 'available' || current.phase === 'error')) {
        offered = null;
        return setState(IDLE);
      }
      return current;
    },

    start(): void {
      if (timer !== null) return;
      // Both refusals are `supported()`; they are spelled out separately here
      // only because the log line is the one place the two are worth telling
      // apart. Windows builds exist, but the swap is written in macOS terms —
      // an .app bundle, two renames, `ditto` — and a running .exe cannot be
      // renamed over, so Windows updates are manual and no card ever appears.
      // In dev the "installed app" is the repo checkout: nothing to update,
      // and a check could only ever offer a downgrade to a release.
      if (process.platform !== 'darwin') {
        log.debug('Updater disabled: macOS only for now.');
        return;
      }
      if (!app.isPackaged) {
        log.debug('Updater disabled: not a packaged build.');
        return;
      }
      stopped = false;
      void sweepParkedBundles();
      const schedule = (delay: number): void => {
        if (stopped) return;
        timer = setTimeout(() => {
          void check({ manual: false }).finally(() => schedule(CHECK_EVERY_MS));
        }, delay);
        timer.unref?.();
      };
      schedule(FIRST_CHECK_MS);
    },

    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
