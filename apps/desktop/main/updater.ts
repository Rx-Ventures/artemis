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
 * Releases sit on the same private GitHub repository this build was published
 * from (`electron-builder.yml`'s `publish` block, `scripts/release.ts`).
 * Private means authenticated — and Artemis holds no credentials, for updates
 * or anything else. The same answer as `claude auth login` applies: the
 * user's own tooling holds the credential. Every tester was given repository
 * access to download the app in the first place, and `gh` uses exactly that
 * access:
 *
 *   1. `gh release download` with the user's own GitHub CLI login, when a
 *      usable `gh` exists.
 *   2. Anonymous HTTPS against the public release URLs — dead code while the
 *      repository is private, and the zero-config path the day it is not.
 *
 * No token is stored, asked for, or accepted. A machine with neither route
 * simply never sees a banner, and the release notes remain the manual path.
 *
 * ## What the renderer sees
 *
 * One {@link UpdateState}, pushed on every change. No URL, no path, no
 * checksum crosses the IPC boundary — the renderer's whole vocabulary is
 * "there is a version", "install it", "not this one".
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
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
const REPO = 'seth-torrence/artemis';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const FEED_NAME = 'latest-mac.yml';

/** First check shortly after launch; then steadily. Both deliberately lazy —
 * an update is never urgent enough to compete with startup. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

/** Where `gh` tends to live when a GUI launch doesn't inherit the shell's PATH. */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')];

const IDLE: UpdateState = { phase: 'idle', version: null, message: null, releaseUrl: null };

export interface Updater {
  /** The state right now, for the pull channel. */
  state(): UpdateState;
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

export function createUpdater(options: UpdaterOptions): Updater {
  const { userDataDir, broadcast } = options;
  const settingsPath = join(userDataDir, 'update-settings.json');

  let current: UpdateState = IDLE;
  /** The feed behind an `available` offer; cleared whenever the offer is. */
  let offered: UpdateFeed | null = null;
  let installing = false;
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
   * Download one release asset into `dir`, via `gh` when available, else the
   * public URL. `tag` is empty for "latest release".
   */
  async function fetchAsset(name: string, tag: string, dir: string): Promise<string> {
    const destination = join(dir, name);
    const gh = resolveGh();
    if (gh !== null) {
      const args = ['release', 'download'];
      if (tag !== '') args.push(tag);
      args.push('-R', REPO, '-p', name, '-D', dir, '--clobber');
      await execFileAsync(gh, args, { env: ghEnv(), timeout: 10 * 60 * 1000 });
      return destination;
    }
    // Anonymous: the stable public download URL. 404s while the repo is private.
    const url =
      tag === ''
        ? `${RELEASES_URL}/latest/download/${name}`
        : `${RELEASES_URL}/download/${tag}/${name}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  }

  /* ----------------------------------------------------------------------- */
  /* The periodic check                                                      */
  /* ----------------------------------------------------------------------- */

  async function check(): Promise<void> {
    // Never check over an active offer or install: an offer mid-download must
    // not be replaced under the banner's feet.
    if (current.phase !== 'idle') return;
    let feed: UpdateFeed | null = null;
    try {
      const dir = await mkdtemp(join(tmpdir(), 'artemis-update-check-'));
      try {
        feed = parseUpdateFeed(await readFile(await fetchAsset(FEED_NAME, '', dir), 'utf8'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      // No gh, no network, no access: all mean "no banner today", not an error
      // surface. The manual path (the releases page) always remains.
      log.debug('Update check did not reach the feed.', error);
      return;
    }
    if (feed === null) {
      log.warn('The update feed did not parse; staying quiet.');
      return;
    }
    const dismissed = await readDismissed();
    if (!shouldOffer({ feedVersion: feed.version, currentVersion: app.getVersion(), dismissedVersion: dismissed })) {
      return;
    }
    offered = feed;
    log.info(`Update available: ${feed.version} (running ${app.getVersion()}).`);
    setState({ phase: 'available', version: feed.version, message: null, releaseUrl: null });
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
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
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
          await rm(join(parent, entry), { recursive: true, force: true });
          log.info(`Removed a parked previous version: ${entry}`);
        }
      }
    } catch {
      // A sweep that cannot run costs disk space, nothing else.
    }
  }

  /* ----------------------------------------------------------------------- */
  /* The surface                                                             */
  /* ----------------------------------------------------------------------- */

  return {
    state: () => current,

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
      if (!app.isPackaged) {
        // In dev the "installed app" is the repo checkout; there is nothing to
        // update and a check would only ever offer a downgrade to a release.
        log.debug('Updater disabled: not a packaged build.');
        return;
      }
      stopped = false;
      void sweepParkedBundles();
      const schedule = (delay: number): void => {
        if (stopped) return;
        timer = setTimeout(() => {
          void check().finally(() => schedule(CHECK_EVERY_MS));
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
