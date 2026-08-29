/**
 * Shells, and the four ways the renderer is allowed to touch one.
 * ============================================================================
 *
 * This is the only file in Artemis that imports `node-pty`, and the only place a
 * process is spawned that the *user* rather than the agent is driving. That
 * distinction is the whole design brief. Everywhere else in the app, execution
 * arrives through a provider adapter and is gated by a permission prompt; here
 * it arrives because somebody pressed a key, and gating it would mean writing a
 * terminal that asks permission to be a terminal.
 *
 * So the containment is not a policy. It is these three facts:
 *
 *  1. **Main picks the program.** The renderer says "a shell, in this directory,
 *     this many columns wide". It never names a binary, never passes an argv and
 *     never contributes to the environment. {@link resolveShell} decides, out of
 *     a fixed list, and a renderer that has been taken over completely still
 *     cannot choose what runs — only what is typed at it, which is exactly what
 *     the person sitting there could already do.
 *  2. **Main owns the ids.** {@link TerminalHost.start} is the only source of a
 *     {@link TerminalId}, and every other method resolves the id it is given
 *     against the registry below. There is no address arithmetic to get wrong:
 *     an id nobody was handed matches nothing.
 *  3. **Main owns the lifetime.** A shell dies when the tab is closed or the app
 *     quits. Nothing else — not closing a pane, not switching session, not
 *     reloading the window — reaches this file, which is what lets a `pnpm dev`
 *     survive the user glancing at another conversation.
 *
 * ## Output is batched, and past a point it is dropped
 *
 * A PTY can emit faster than IPC can carry and far faster than anyone can read:
 * `yes` produces tens of megabytes a second and `find /` is not much kinder. Two
 * bounds keep that from becoming the app's problem.
 *
 * **Batching** ({@link FLUSH_MS}) turns thousands of tiny `onData` callbacks into
 * about sixty messages a second. This alone is the difference between a
 * responsive window and a saturated one.
 *
 * **Tail-dropping** ({@link MAX_FLUSH_BYTES}) bounds each of those messages. When
 * a single batch overflows, the *end* is kept and the middle is discarded, on
 * the grounds that output arriving at ten megabytes a second was never going to
 * be read and the part anyone cares about is where it stopped. The alternative
 * is real flow control — pause the PTY, wait for the renderer to acknowledge
 * each chunk, resume — which is what VS Code does and is genuinely better. It is
 * also an ack protocol on the hot path, and it is deliberately not here: this
 * degrades a flood that nobody can read, and does nothing at all to output that
 * arrives at a human pace.
 *
 * ## The replay buffer is what makes a reload survivable
 *
 * Every terminal keeps the tail of what it has printed ({@link MAX_REPLAY_BYTES}).
 * A renderer that reloads has lost its xterm instances but not the shells, and
 * `list` + `replay` are how it gets a screenful back. It is a bounded tail and
 * not a transcript, which is the honest shape: a terminal is a view onto a
 * running process, and scrollback outliving the window showing it is a promise
 * this does not make.
 */

import { randomBytes } from 'node:crypto';
import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import type {
  TerminalEvent,
  TerminalId,
  TerminalInfo,
  TerminalStartRequest,
  Unsubscribe,
} from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('terminal');

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many shells may run at once.
 *
 * Twice the renderer's pane ceiling of eight (`MAX_PANES`), and deliberately
 * not equal to it, because shells are not one-per-pane in either direction: a
 * pane can open several through the strip's `+`, and a shell outlives its
 * conversation leaving the screen — a backgrounded session keeps its
 * `pnpm dev` running, which is the dock's whole promise. Sixteen is headroom
 * over the worst-case grid rather than a product decision: this is a backstop,
 * so a renderer bug that called `start` in a loop should exhaust a counter,
 * not the machine's process table.
 */
export const MAX_TERMINALS = 16;

/**
 * How many *dead* terminals are kept around.
 *
 * A record outlives its process so the tab can go on showing whatever the shell
 * said before it died — a failed `exec`, a stack trace, `exit 1`. That is worth
 * keeping for the one the user is looking at and not worth keeping for the
 * ninety before it, so the oldest are evicted past this.
 */
const MAX_EXITED = 8;

/** How long output accumulates before it is sent. Roughly one frame. */
const FLUSH_MS = 16;

/** The largest single batch. Beyond this the tail is kept — see the header. */
const MAX_FLUSH_BYTES = 128 * 1024;

/** How much of each terminal's output stays replayable. */
const MAX_REPLAY_BYTES = 256 * 1024;

/* -------------------------------------------------------------------------- */
/* The node-pty seam                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The part of node-pty this file uses.
 *
 * Declared structurally rather than imported as a type so that the tests can
 * supply a fake without node-pty being loadable at all — which matters because
 * it is a native module, and the CI machine that runs the unit tests is not
 * necessarily one that could build it.
 */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Record<string, string>;
}

/** How a shell is started. Injectable so the registry is testable. */
export type PtySpawn = (
  file: string,
  args: readonly string[],
  options: PtySpawnOptions,
) => PtyProcess;

/**
 * Load node-pty, once, on first use.
 *
 * Deliberately lazy. A static import would run the native binding's `dlopen`
 * during main's module evaluation, so a node-pty that failed to install — a
 * platform with no prebuild and no compiler, a half-finished `pnpm install` —
 * would stop Artemis from starting at all. Loading it here means the failure
 * lands on "open a terminal" and is reported as one, and every other part of
 * the app goes on working.
 */
let ptyModule: Promise<{ spawn: PtySpawn }> | null = null;

function loadPty(): Promise<{ spawn: PtySpawn }> {
  ptyModule ??= (async () => {
    await ensureHelperExecutable();
    const loaded = (await import('node-pty')) as unknown as { spawn: PtySpawn };
    return { spawn: loaded.spawn };
  })();
  return ptyModule;
}

/**
 * The unpacked twin of a path that points inside an asar archive.
 *
 * `asarUnpack` extracts a file to `app.asar.unpacked/…` and leaves a stub
 * behind in the archive, but module resolution goes on answering with the
 * *archive* path: `require.resolve('node-pty')` in a packaged Artemis returns
 * `…/Resources/app.asar/node_modules/node-pty/lib/index.js`, not the extracted
 * copy beside it. Nothing can chmod that path — `app.asar` is a file, so the
 * call fails with `ENOTDIR` — and nothing can exec it either.
 *
 * This is character-for-character the substitution node-pty performs on its own
 * helper path in `unixTerminal.js`, and it has to be: the whole point of the
 * repair below is to chmod *exactly* the file node-pty will later exec, so the
 * two have to agree about which file that is. Like node-pty's, this replaces
 * only the first occurrence. In a checkout there is no `app.asar` in the path
 * at all and it returns its argument unchanged.
 */
function unpacked(path: string): string {
  return path
    .replace('app.asar', 'app.asar.unpacked')
    .replace('node_modules.asar', 'node_modules.asar.unpacked');
}

/**
 * Where `spawn-helper` could be, given the directory node-pty resolved to.
 *
 * Two layouts, because which one exists depends on how the module arrived:
 * `prebuilds/` when a prebuilt binary was used, `build/Release/` when node-gyp
 * compiled it locally (every Linux, including CI's). Both are mapped out of the
 * archive by {@link unpacked}.
 *
 * Pure and exported for its tests: the packaged case is the one that broke, and
 * it is not reproducible from a checkout — there is no `app.asar` to resolve
 * out of — so the mapping has to be assertable on its own.
 */
export function spawnHelperCandidates(
  packageRoot: string,
  platform: NodeJS.Platform,
  arch: string,
): readonly string[] {
  return [
    join(packageRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ].map(unpacked);
}

/**
 * Make node-pty's `spawn-helper` executable, if it is not already.
 *
 * On macOS and Linux node-pty does not `fork`/`exec` directly; it runs a tiny
 * helper binary that sets up the controlling terminal. **The prebuilt packages
 * ship that helper without its executable bit** — `scripts/post-install.js`
 * cleans the build folder and moves a DLL on Windows, and never chmods
 * anything — so a fresh install spawns exactly once and fails with
 * `posix_spawnp failed`, an error that names neither the file nor the
 * permission.
 *
 * `asarUnpack` copies the helper out of the archive with the mode it had going
 * in, so a packaged Artemis inherits the same missing bit. That is what
 * {@link unpacked} is for, and getting it wrong is what made this bug survive a
 * first fix: the repair used to chmod the *archive* path, which fails with
 * `ENOTDIR` every time, into a `catch` that could not tell that apart from a
 * layout being absent. It logged nothing, repaired nothing, and left the error
 * to surface in production as `posix_spawnp failed` — the exact message the
 * function exists to prevent.
 *
 * So the two failures are caught separately now. A missing candidate is the
 * common case and stays silent; a chmod that fails is a real problem and says
 * so, with the path in the message.
 *
 * This is the second line of defence rather than the first. `build/after-pack.cjs`
 * sets the bit at package time, which is the only place it can be set for an
 * install the user cannot write to — under `/Applications` owned by an admin,
 * or run straight off the read-only DMG. This repairs checkouts, and installs
 * packaged before that hook existed.
 *
 * `chmod` does not disturb a code signature — that covers contents, not mode —
 * so this is safe inside a signed bundle.
 */
async function ensureHelperExecutable(): Promise<void> {
  if (process.platform === 'win32') return;

  const require = createRequire(import.meta.url);
  let packageRoot: string;
  try {
    // `node-pty/lib/index.js` → `node-pty/`.
    packageRoot = dirname(dirname(require.resolve('node-pty')));
  } catch (error) {
    log.warn('Could not locate node-pty to check its spawn helper.', error);
    return;
  }

  for (const candidate of spawnHelperCandidates(packageRoot, process.platform, process.arch)) {
    let mode: number;
    try {
      mode = (await stat(candidate)).mode;
    } catch {
      // A layout that is not present is the common case, not an error.
      continue;
    }

    // Any execute bit is enough; node-pty runs it as the current user.
    if ((mode & 0o111) !== 0) continue;

    try {
      await chmod(candidate, 0o755);
      log.info(`Marked ${basename(candidate)} executable; the prebuild ships it without the bit.`);
    } catch (error) {
      log.warn(
        `Could not make ${candidate} executable, so opening a terminal will fail with ` +
          '"posix_spawnp failed". A read-only or another user\'s install cannot be repaired ' +
          'from here; reinstalling Artemis is what fixes it.',
        error,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Shell and environment                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Shells whose `-l` contract is understood. Anything else falls back.
 *
 * An allowlist rather than "run whatever `$SHELL` says", because `$SHELL` is an
 * environment variable and this file's first rule is that main chooses the
 * program. A user whose shell is not on this list gets a working terminal
 * running a shell they recognise, rather than a spawn of something arbitrary.
 */
const KNOWN_SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh']);

/**
 * Environment variables the shell must not inherit from Artemis.
 *
 * `ELECTRON_RUN_AS_NODE` is the one that actually breaks things: with it set,
 * every `electron` and — on a machine where `node` is a shim around one —
 * every `node` the user runs behaves as a bare Node process. `NODE_OPTIONS`
 * leaks Artemis's own flags into anything the user starts.
 *
 * The two config-directory variables are **load-bearing, not defensive**, and
 * the comment here used to say the opposite. A run's environment is composed per
 * spawn and never reaches `process.env` — that part is still true — but it is
 * not the only writer. The Claude adapter's standalone session functions take no
 * environment and resolve their store from `process.env`, so reading history
 * sets `CLAUDE_CONFIG_DIR` on this process for the duration of the call and puts
 * it back afterwards (`withClaudeConfigDir`). That window is short and it is
 * real: a terminal opened while the sidebar happens to be reading a profile's
 * history would inherit that profile's config directory, and the user's own
 * `claude` in their own shell would silently run as another account — reading
 * its history, and billing it.
 *
 * So this strip is what makes the terminal's environment independent of whatever
 * the rest of the app is doing at the instant it spawns, and it must not be
 * removed on the grounds that nothing sets these. Something does.
 */
const STRIPPED_ENV = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'NODE_OPTIONS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
];

/** What to spawn, and how, on this platform. Pure — see `shellPath.ts`'s split. */
export function resolveShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { readonly file: string; readonly args: readonly string[] } {
  if (platform === 'win32') {
    // Present on every supported Windows, unlike `pwsh`, and driven through
    // ConPTY by node-pty. No `-l`: PowerShell has no login-shell notion.
    return { file: 'powershell.exe', args: [] };
  }

  const preferred = env['SHELL'];
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  const file =
    preferred !== undefined && preferred !== '' && KNOWN_SHELLS.has(basename(preferred))
      ? preferred
      : fallback;

  // A login shell, which is what a terminal emulator starts and therefore what
  // the user's profile is written expecting. It is also how the shell's own PATH
  // gets built — `adoptLoginShellPath` solves that for what *Artemis* spawns,
  // and this solves the same problem for what the *user* spawns.
  return { file, args: ['-l'] };
}

/** The environment a shell starts in. Pure, for the same reason. */
export function buildEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of STRIPPED_ENV) delete env[key];

  // What the terminal is, as programs will ask. `xterm-256color` is what xterm.js
  // implements and is present in every terminfo database worth the name;
  // `COLORTERM` is the out-of-band way anything modern detects 24-bit colour.
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  return env;
}

/* -------------------------------------------------------------------------- */
/* The retained tail                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The last `limit` characters of a stream, kept without re-slicing on every
 * write.
 *
 * Chunks are dropped whole from the front rather than the string being cut to
 * length, which costs a little accuracy — the first retained chunk can begin in
 * the middle of an escape sequence — and saves copying a quarter of a megabyte
 * on every keystroke's worth of echo. {@link truncated} is what lets the reader
 * know the head is missing rather than wondering why the first line looks odd.
 *
 * Exported for its tests; nothing outside this file constructs one.
 */
export class TailBuffer {
  private chunks: string[] = [];
  private length = 0;
  private dropped = false;

  constructor(private readonly limit: number) {}

  append(text: string): void {
    if (text === '') return;
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > this.limit && this.chunks.length > 1) {
      const front = this.chunks.shift() as string;
      this.length -= front.length;
      this.dropped = true;
    }
    // One chunk longer than the whole budget: cut it, since there is nothing
    // left to drop and holding ten megabytes because it arrived at once would
    // defeat the bound entirely.
    if (this.length > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0] as string;
      this.chunks[0] = only.slice(only.length - this.limit);
      this.length = this.limit;
      this.dropped = true;
    }
  }

  read(): { readonly data: string; readonly truncated: boolean } {
    return { data: this.chunks.join(''), truncated: this.dropped };
  }
}

/** Keep the last `limit` characters. Used to bound one batch; see the header. */
export function keepTail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/** One live (or recently dead) terminal. */
interface Entry {
  readonly info: { -readonly [K in keyof TerminalInfo]: TerminalInfo[K] };
  readonly pty: PtyProcess;
  readonly buffer: TailBuffer;
  /** Output accumulated since the last flush. See {@link FLUSH_MS}. */
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Everything the IPC layer can ask of a terminal.
 *
 * An object rather than module-level functions, matching `EngineHost` and
 * `Updater`: it is constructed once in `index.ts` and handed to
 * `registerIpcHandlers`, which is what lets a test build one over a fake pty
 * without touching a global.
 */
export interface TerminalHost {
  start(request: TerminalStartRequest): Promise<TerminalInfo>;
  write(id: TerminalId, data: string): void;
  resize(id: TerminalId, cols: number, rows: number): void;
  close(id: TerminalId): void;
  list(): readonly TerminalInfo[];
  replay(id: TerminalId): { readonly data: string; readonly truncated: boolean };
  /** True for an id this registry issued and has not forgotten. */
  has(id: TerminalId): boolean;
  subscribe(listener: (event: TerminalEvent) => void): Unsubscribe;
  /** Kill every shell. For `before-quit`. */
  disposeAll(): void;
}

export interface TerminalHostOptions {
  /** Overrides node-pty. Tests pass a fake; nothing in the app passes anything. */
  readonly spawn?: PtySpawn;
  /**
   * Overrides the async node-pty module load. Tests use it to hold `start` at
   * its first `await` — the window in which the cap's reservation has to bind —
   * which a synchronous {@link spawn} override can never open.
   */
  readonly loadSpawn?: () => Promise<PtySpawn>;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected so a test does not have to wait a real frame for a flush. */
  readonly flushMs?: number;
}

/** Raised for a request naming a terminal the registry does not know. */
export class UnknownTerminalError extends Error {
  constructor(id: TerminalId) {
    super(`There is no terminal ${id}.`);
    this.name = 'UnknownTerminalError';
  }
}

/** Raised when {@link MAX_TERMINALS} shells are already running. */
export class TooManyTerminalsError extends Error {
  constructor() {
    super(`Artemis will not run more than ${MAX_TERMINALS} terminals at once.`);
    this.name = 'TooManyTerminalsError';
  }
}

export function createTerminalHost(options: TerminalHostOptions = {}): TerminalHost {
  const platform = options.platform ?? process.platform;
  const baseEnv = options.env ?? process.env;
  const flushMs = options.flushMs ?? FLUSH_MS;

  const entries = new Map<TerminalId, Entry>();
  const listeners = new Set<(event: TerminalEvent) => void>();

  // Starts that have passed the cap check but not yet registered in `entries`.
  // The count-then-spawn sequence below awaits (`loadPty`), so without this
  // reservation N concurrent starts would each see the same count and the cap
  // would only ever bind sequential callers.
  let reserved = 0;

  const emit = (event: TerminalEvent): void => {
    // A copy, so a listener that unsubscribes while being notified does not
    // disturb this pass — the same rule the preload's fan-out states.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        log.error('A terminal listener threw; the rest still ran.', error);
      }
    }
  };

  const flush = (entry: Entry): void => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pending.length === 0) return;
    const joined = entry.pending.join('');
    entry.pending = [];
    emit({ type: 'data', id: entry.info.id, data: keepTail(joined, MAX_FLUSH_BYTES) });
  };

  /**
   * Drop dead terminals past {@link MAX_EXITED}, oldest first.
   *
   * `Map` iterates in insertion order, so "oldest" needs no timestamp — the same
   * trick `preview.ts` uses for its granted snapshots.
   */
  const pruneExited = (): void => {
    const dead = [...entries.values()].filter((entry) => entry.info.exited);
    for (const entry of dead.slice(0, Math.max(0, dead.length - MAX_EXITED))) {
      entries.delete(entry.info.id);
    }
  };

  return {
    async start(request: TerminalStartRequest): Promise<TerminalInfo> {
      const live = [...entries.values()].filter((entry) => !entry.info.exited);
      if (live.length + reserved >= MAX_TERMINALS) throw new TooManyTerminalsError();
      // Held across the awaits below, so concurrent starts each count the ones
      // already in flight; released in the `finally` once the entry is
      // registered (or the spawn failed).
      reserved += 1;
      try {
        const spawn =
          options.spawn ??
          (options.loadSpawn !== undefined ? await options.loadSpawn() : (await loadPty()).spawn);
        const { file, args } = resolveShell(platform, baseEnv);

        /*
         * Random, not sequential, for the same reason `preview.ts` mints random
         * grant tokens: the contract calls this an unguessable handle, and
         * `term-1` would make that sentence false. Nothing today can exploit a
         * sequential id — Artemis opens exactly one window, and `list` would hand
         * a second one every id anyway — but "the renderer can only name a
         * terminal it was given" is a property worth being true rather than
         * nearly true, and sixteen bytes is not a cost.
         */
        const id: TerminalId = `term-${randomBytes(12).toString('hex')}`;

        const pty = spawn(file, args, {
          name: 'xterm-256color',
          cwd: request.cwd,
          cols: request.cols,
          rows: request.rows,
          env: buildEnv(baseEnv),
        });

        const entry: Entry = {
          info: {
            id,
            shell: file,
            cwd: request.cwd,
            startedAt: Date.now(),
            exited: false,
          },
          pty,
          buffer: new TailBuffer(MAX_REPLAY_BYTES),
          pending: [],
          timer: null,
        };
        entries.set(id, entry);
        pruneExited();

        pty.onData((data) => {
          entry.buffer.append(data);
          entry.pending.push(data);
          entry.timer ??= setTimeout(() => flush(entry), flushMs);
        });

        pty.onExit(({ exitCode, signal }) => {
          // Flush first: a program's last words are usually the reason it ended,
          // and they are sitting in `pending` at exactly this moment.
          flush(entry);
          entry.info.exited = true;
          emit({
            type: 'exit',
            id,
            exitCode,
            ...(signal === undefined ? {} : { signal }),
          });
        });

        log.info(`Started ${basename(file)} (pid ${String(pty.pid)}) in ${request.cwd}.`);
        return { ...entry.info };
      } finally {
        reserved -= 1;
      }
    },

    write(id: TerminalId, data: string): void {
      const entry = entries.get(id);
      if (entry === undefined) throw new UnknownTerminalError(id);
      // Writing to a dead shell is not an error worth surfacing: the tab is
      // still on screen so the keystroke is plausible, and there is nothing to
      // deliver it to.
      if (entry.info.exited) return;
      entry.pty.write(data);
    },

    resize(id: TerminalId, cols: number, rows: number): void {
      const entry = entries.get(id);
      if (entry === undefined) throw new UnknownTerminalError(id);
      if (entry.info.exited) return;
      entry.pty.resize(cols, rows);
    },

    close(id: TerminalId): void {
      const entry = entries.get(id);
      if (entry === undefined) throw new UnknownTerminalError(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      entries.delete(id);
      if (entry.info.exited) return;
      try {
        entry.pty.kill();
      } catch (error) {
        // Already gone between the check and the call. Nothing to do about it,
        // and the record has been dropped either way.
        log.debug(`Killing terminal ${id} failed; it had probably already exited.`, error);
      }
    },

    list(): readonly TerminalInfo[] {
      return [...entries.values()].map((entry) => ({ ...entry.info }));
    },

    replay(id: TerminalId): { readonly data: string; readonly truncated: boolean } {
      const entry = entries.get(id);
      if (entry === undefined) throw new UnknownTerminalError(id);
      // Anything pending is part of "what is on screen" as far as the caller is
      // concerned, and it is already in the buffer — the flush timer only
      // governs when it is *pushed*.
      return entry.buffer.read();
    },

    has(id: TerminalId): boolean {
      return entries.has(id);
    },

    subscribe(listener: (event: TerminalEvent) => void): Unsubscribe {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },

    disposeAll(): void {
      for (const entry of entries.values()) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (entry.info.exited) continue;
        try {
          entry.pty.kill();
        } catch {
          // Quitting. A shell that will not die is the OS's problem now.
        }
      }
      entries.clear();
      listeners.clear();
    },
  };
}
