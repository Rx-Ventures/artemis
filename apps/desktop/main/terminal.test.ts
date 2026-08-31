/**
 * The PTY registry: its bounds, its lifetime rules, and one real shell.
 *
 * Two halves, deliberately:
 *
 *  - **Against a fake pty**, for everything that is a rule rather than a
 *    syscall — the concurrency cap, the retained tail, batching, what happens to
 *    a record when its process dies. These are the parts that would break
 *    silently, and none of them needs a process to be exercised.
 *  - **Against a real one**, once, at the end. That case is not about the
 *    registry at all: it is about node-pty actually loading and actually
 *    spawning on this machine, which is the thing a unit test cannot fake and
 *    the thing that broke first — see `ensureHelperExecutable`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildEnv,
  createTerminalHost,
  keepTail,
  MAX_TERMINALS,
  resolveShell,
  spawnHelperCandidates,
  TailBuffer,
  TooManyTerminalsError,
  UnknownTerminalError,
  type PtyProcess,
  type PtySpawn,
} from './terminal.js';
import { validateTerminalWrite } from './validate.js';

/* -------------------------------------------------------------------------- */
/* A pty that is not one                                                      */
/* -------------------------------------------------------------------------- */

interface FakePty extends PtyProcess {
  /** Push output as though the child had printed it. */
  emit(data: string): void;
  /** End the child. */
  end(exitCode: number, signal?: number): void;
  readonly written: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
  killed: boolean;
}

function fakeSpawn(): { spawn: PtySpawn; made: FakePty[] } {
  const made: FakePty[] = [];
  const spawn: PtySpawn = () => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
    const pty: FakePty = {
      pid: 1000 + made.length,
      written: [],
      resizes: [],
      killed: false,
      onData: (listener) => {
        onData = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      write: (data) => pty.written.push(data),
      resize: (cols, rows) => pty.resizes.push({ cols, rows }),
      kill: () => {
        pty.killed = true;
      },
      emit: (data) => onData(data),
      end: (exitCode, signal) => onExit(signal === undefined ? { exitCode } : { exitCode, signal }),
    };
    made.push(pty);
    return pty;
  };
  return { spawn, made };
}

const start = { cwd: '/tmp', cols: 80, rows: 24 };

/** A host over fake ptys, with batching short enough not to slow the suite. */
function host(overrides: Parameters<typeof createTerminalHost>[0] = {}) {
  const { spawn, made } = fakeSpawn();
  return {
    made,
    host: createTerminalHost({ spawn, platform: 'darwin', env: {}, flushMs: 1, ...overrides }),
  };
}

/* -------------------------------------------------------------------------- */

describe('resolveShell', () => {
  it('takes $SHELL when it is one it understands', () => {
    expect(resolveShell('darwin', { SHELL: '/opt/homebrew/bin/fish' })).toEqual({
      file: '/opt/homebrew/bin/fish',
      args: ['-l'],
    });
  });

  /*
   * The allowlist is the point rather than an optimisation. `SHELL` is an
   * environment variable, and this file's first rule is that main chooses the
   * program — so an unrecognised value falls back rather than being spawned.
   *
   * `exists` is injected in all of these. Left to the real filesystem they
   * would assert the *host's* shells rather than the fallback logic, and pass
   * or fail depending on which runner ran them — the macOS expectations below
   * would break on a Linux box with no zsh installed.
   */
  it('falls back rather than spawning whatever $SHELL names', () => {
    const all = (): boolean => true;
    expect(resolveShell('darwin', { SHELL: '/usr/local/bin/evil' }, all).file).toBe('/bin/zsh');
    expect(resolveShell('linux', { SHELL: '' }, all).file).toBe('/bin/bash');
    expect(resolveShell('darwin', {}, all).file).toBe('/bin/zsh');
  });

  /*
   * The fallback used to be one string per platform, so a machine without it
   * had no terminal at all. A Fedora container with neither bash nor zsh, or a
   * NixOS box where `/bin/sh` is the only FHS path that survives, is the case.
   */
  it('walks past fallbacks the machine does not have', () => {
    const only =
      (...paths: readonly string[]) =>
      (path: string): boolean =>
        paths.includes(path);
    expect(resolveShell('linux', {}, only('/bin/sh')).file).toBe('/bin/sh');
    expect(resolveShell('linux', {}, only('/usr/bin/bash', '/bin/sh')).file).toBe('/usr/bin/bash');
    expect(resolveShell('darwin', {}, only('/bin/bash')).file).toBe('/bin/bash');
  });

  /*
   * Nothing to spawn is still an argv: `/bin/sh` is the one path worth failing
   * on, because node-pty's error then names a file the user can go and check.
   */
  it('lands on /bin/sh when nothing in the chain exists', () => {
    expect(resolveShell('linux', {}, () => false).file).toBe('/bin/sh');
  });

  it('uses PowerShell on Windows, with no login flag', () => {
    expect(resolveShell('win32', { SHELL: '/bin/zsh' })).toEqual({
      file: 'powershell.exe',
      args: [],
    });
  });
});

describe('buildEnv', () => {
  it('declares what the terminal is', () => {
    const env = buildEnv({ PATH: '/usr/bin' });
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
    expect(env['PATH']).toBe('/usr/bin');
  });

  /*
   * `ELECTRON_RUN_AS_NODE` is the one that actually breaks a user's shell:
   * with it set, `node` and `electron` in that shell behave as bare Node. The
   * config-dir variables are defensive — see the comment on `STRIPPED_ENV`.
   */
  it('strips what a user shell must not inherit from Artemis', () => {
    const env = buildEnv({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--max-old-space-size=8192',
      CLAUDE_CONFIG_DIR: '/profiles/work',
      HOME: '/Users/me',
    });
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(env['HOME']).toBe('/Users/me');
  });
});

describe('TailBuffer', () => {
  it('keeps everything while it fits', () => {
    const buffer = new TailBuffer(100);
    buffer.append('one ');
    buffer.append('two');
    expect(buffer.read()).toEqual({ data: 'one two', truncated: false });
  });

  it('drops whole chunks from the front, and says so', () => {
    const buffer = new TailBuffer(10);
    buffer.append('aaaaa');
    buffer.append('bbbbb');
    buffer.append('ccccc');
    const { data, truncated } = buffer.read();
    expect(data).toBe('bbbbbccccc');
    expect(truncated).toBe(true);
  });

  /*
   * The case the chunk-dropping loop cannot handle on its own: one write bigger
   * than the entire budget. Without the second branch the buffer would hold it
   * whole, and the bound would be advisory.
   */
  it('cuts a single chunk larger than the whole budget', () => {
    const buffer = new TailBuffer(10);
    buffer.append('x'.repeat(1000));
    const { data, truncated } = buffer.read();
    expect(data).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});

describe('keepTail', () => {
  it('keeps the end, which is the part anyone is still reading', () => {
    expect(keepTail('abcdef', 3)).toBe('def');
    expect(keepTail('ab', 5)).toBe('ab');
  });
});

describe('the terminal host', () => {
  it('reports what it started', async () => {
    const { host: terminals } = host();
    const info = await terminals.start(start);
    expect(info.cwd).toBe('/tmp');
    expect(info.shell).toBe('/bin/zsh');
    expect(info.exited).toBe(false);
    expect(terminals.has(info.id)).toBe(true);
  });

  /*
   * A cross-layer check, and the kind that fails silently.
   *
   * Main mints these ids and main's own validator has to accept them back,
   * because every request after `start` echoes one. The two live in different
   * files with no shared constant, so a future id format with a `/` or a space
   * in it would compile, pass every test in this file, and then reject every
   * keystroke at the IPC boundary with a validation error about an identifier
   * the user never typed.
   */
  it('mints ids its own validator accepts', async () => {
    const { host: terminals } = host();
    const info = await terminals.start(start);
    expect(validateTerminalWrite({ id: info.id, data: 'ls' })).toEqual({
      id: info.id,
      data: 'ls',
    });
  });

  it('gives each terminal an id nobody could have guessed', async () => {
    const { host: terminals } = host();
    const first = await terminals.start(start);
    const second = await terminals.start(start);
    expect(first.id).not.toBe(second.id);
    // Long enough not to be enumerable, which is what the contract claims.
    expect(first.id.length).toBeGreaterThan(16);
  });

  it('refuses a request naming a terminal it never issued', async () => {
    const { host: terminals } = host();
    expect(() => terminals.write('term-nope', 'ls')).toThrow(UnknownTerminalError);
    expect(() => terminals.resize('term-nope', 80, 24)).toThrow(UnknownTerminalError);
    expect(() => terminals.replay('term-nope')).toThrow(UnknownTerminalError);
  });

  it('will not run more than the cap', async () => {
    const { host: terminals } = host();
    for (let i = 0; i < MAX_TERMINALS; i += 1) await terminals.start(start);
    await expect(terminals.start(start)).rejects.toThrow(TooManyTerminalsError);
  });

  /*
   * The cap must bind callers that arrive together, not just one at a time. A
   * synchronous spawn override never yields, so the check-then-register window
   * does not exist under the other tests here; the async loader is the seam
   * that opens it, exactly the way the real node-pty import does. Without the
   * reservation, every one of these starts counts zero live shells and all of
   * them spawn.
   */
  it('holds the cap against concurrent starts', async () => {
    const { spawn } = fakeSpawn();
    let open = (): void => {};
    const gate = new Promise<PtySpawn>((resolve) => {
      open = () => resolve(spawn);
    });
    const terminals = createTerminalHost({
      platform: 'darwin',
      env: {},
      flushMs: 1,
      loadSpawn: () => gate,
    });

    const attempts = Array.from({ length: MAX_TERMINALS + 4 }, () =>
      terminals.start(start).then(
        () => 'ok' as const,
        (error: unknown) => error,
      ),
    );
    open();
    const settled = await Promise.all(attempts);

    expect(settled.filter((outcome) => outcome === 'ok')).toHaveLength(MAX_TERMINALS);
    expect(settled.filter((outcome) => outcome instanceof TooManyTerminalsError)).toHaveLength(4);
  });

  /* A shell that has exited does not hold a slot; a tab left open is not a
     process, and the user should be able to open another. */
  it('counts only live shells against the cap', async () => {
    const { host: terminals, made } = host();
    const first = await terminals.start(start);
    for (let i = 1; i < MAX_TERMINALS; i += 1) await terminals.start(start);
    (made[0] as FakePty).end(0);
    expect(first).toBeDefined();
    await expect(terminals.start(start)).resolves.toBeDefined();
  });

  it('batches output into one event instead of one per chunk', async () => {
    vi.useFakeTimers();
    try {
      const { host: terminals, made } = host({ flushMs: 16 });
      const info = await terminals.start(start);
      const seen: string[] = [];
      terminals.subscribe((event) => {
        if (event.type === 'data') seen.push(event.data);
      });

      const pty = made[0] as FakePty;
      for (let i = 0; i < 50; i += 1) pty.emit(`line ${String(i)}\n`);
      expect(seen).toHaveLength(0); // nothing yet: still inside the window

      vi.advanceTimersByTime(20);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('line 0');
      expect(seen[0]).toContain('line 49');
      expect(terminals.replay(info.id).data).toContain('line 49');
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * The exit event must carry whatever was still pending, because a program's
   * last words are usually the reason it ended — and at the moment it exits they
   * are sitting in the batch that has not been flushed yet.
   */
  it('flushes pending output before reporting an exit', async () => {
    const { host: terminals, made } = host({ flushMs: 10_000 });
    const events: string[] = [];
    terminals.subscribe((event) =>
      events.push(event.type === 'data' ? `data:${event.data}` : `exit:${String(event.exitCode)}`),
    );

    await terminals.start(start);
    const pty = made[0] as FakePty;
    pty.emit('command not found\n');
    pty.end(127);

    expect(events).toEqual(['data:command not found\n', 'exit:127']);
  });

  it('keeps a dead terminal on the books so its last words stay readable', async () => {
    const { host: terminals, made } = host();
    const info = await terminals.start(start);
    (made[0] as FakePty).emit('goodbye');
    (made[0] as FakePty).end(1);

    expect(terminals.has(info.id)).toBe(true);
    expect(terminals.list()[0]?.exited).toBe(true);
    expect(terminals.replay(info.id).data).toBe('goodbye');
    // And writing to it is a no-op rather than a throw: the tab is still on
    // screen, so a keystroke is plausible.
    expect(() => terminals.write(info.id, 'x')).not.toThrow();
  });

  it('kills the shell on close, and forgets it', async () => {
    const { host: terminals, made } = host();
    const info = await terminals.start(start);
    terminals.close(info.id);

    expect((made[0] as FakePty).killed).toBe(true);
    expect(terminals.has(info.id)).toBe(false);
  });

  it('passes input and sizes straight through', async () => {
    const { host: terminals, made } = host();
    const info = await terminals.start(start);
    // A NUL is `Ctrl-@`, a key people press. Nothing on this path may drop it.
    terminals.write(info.id, 'ls -la\r ');
    terminals.resize(info.id, 120, 40);

    expect((made[0] as FakePty).written).toEqual(['ls -la\r ']);
    expect((made[0] as FakePty).resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('kills everything on dispose', async () => {
    const { host: terminals, made } = host();
    await terminals.start(start);
    await terminals.start(start);
    terminals.disposeAll();

    expect(made.every((pty) => pty.killed)).toBe(true);
    expect(terminals.list()).toEqual([]);
  });

  it('stops delivering to a listener that unsubscribed', async () => {
    const { host: terminals, made } = host({ flushMs: 1 });
    const seen: string[] = [];
    const stop = terminals.subscribe((event) => {
      if (event.type === 'data') seen.push(event.data);
    });
    await terminals.start(start);
    stop();
    (made[0] as FakePty).emit('after');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Finding the spawn helper                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The packaged case, which is the one that shipped broken.
 *
 * `spawn-helper` has no execute bit in node-pty's published tarball, so
 * something has to add it, and for a long time nothing did: the repair chmodded
 * the path `require.resolve` returns, which inside a bundle points *into*
 * `app.asar`. chmod fails there with `ENOTDIR`, the failure was swallowed, and
 * 0.6.1 shipped a terminal that could not start. Meanwhile the real-shell test
 * below passed on every machine, because a checkout has no archive to resolve
 * out of and its helper had already been chmodded in place.
 *
 * That is the gap these fill. They are string assertions about a path, which is
 * all the bug ever was.
 *
 * Skipped on Windows, where node-pty runs no helper at all and
 * `ensureHelperExecutable` returns before reaching this: the bundle layouts
 * below are macOS and Linux paths, and `join` respells them with backslashes on
 * whichever host it runs on.
 */
describe.skipIf(process.platform === 'win32')('spawnHelperCandidates', () => {
  const bundle = '/Applications/Artemis.app/Contents/Resources/app.asar/node_modules/node-pty';

  it('points outside the archive for a packaged app', () => {
    // Every candidate, because chmod on any `app.asar` path throws ENOTDIR —
    // there is no layout for which the archive path is the right answer.
    for (const candidate of spawnHelperCandidates(bundle, 'darwin', 'arm64')) {
      expect(candidate).toContain('app.asar.unpacked');
      expect(candidate).not.toMatch(/app\.asar(?!\.unpacked)/);
    }
  });

  it('agrees with node-pty about where the helper is', () => {
    // node-pty computes its exec path as `<native.dir>/spawn-helper` and then
    // applies exactly this substitution (`lib/unixTerminal.js`). Chmodding a
    // different file than the one it execs would repair nothing, so this is
    // the assertion that the two cannot drift apart silently.
    expect(spawnHelperCandidates(bundle, 'darwin', 'arm64')[0]).toBe(
      '/Applications/Artemis.app/Contents/Resources/app.asar.unpacked' +
        '/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    );
  });

  it('maps a node_modules.asar bundle too', () => {
    const [prebuilt] = spawnHelperCandidates('/app/node_modules.asar/node-pty', 'linux', 'x64');
    expect(prebuilt).toBe(
      '/app/node_modules.asar.unpacked/node-pty/prebuilds/linux-x64/spawn-helper',
    );
  });

  it('leaves a checkout path alone', () => {
    const root = '/Users/dev/artemis/node_modules/node-pty';
    expect(spawnHelperCandidates(root, 'darwin', 'arm64')).toEqual([
      `${root}/prebuilds/darwin-arm64/spawn-helper`,
      `${root}/build/Release/spawn-helper`,
    ]);
  });

  it('covers both layouts, since which one exists depends on the install', () => {
    // `prebuilds/` for a downloaded binary, `build/Release/` for one node-gyp
    // compiled here — Linux, and CI, get the second.
    const candidates = spawnHelperCandidates('/pkg/node-pty', 'linux', 'x64');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain('/prebuilds/linux-x64/');
    expect(candidates[1]).toContain('/build/Release/');
  });
});

/* -------------------------------------------------------------------------- */
/* One real shell                                                             */
/* -------------------------------------------------------------------------- */

/**
 * node-pty, actually loaded and actually spawned.
 *
 * The one case here that is not about the registry. It exists because the first
 * thing that broke in this feature was neither logic nor types: node-pty's
 * prebuilt package ships `spawn-helper` **without its executable bit**, so every
 * spawn failed with `posix_spawnp failed` — a message that names neither the
 * file nor the permission. `ensureHelperExecutable` repairs that, and this is
 * what would notice if it stopped working, or if a future node-pty changed
 * where the helper lives.
 *
 * Windows-skipped only because the assertion below is a POSIX shell command;
 * the ConPTY path is exercised by the app rather than here.
 */
describe.skipIf(process.platform === 'win32')('node-pty itself', () => {
  it('spawns a real shell that runs a real command', { timeout: 20_000 }, async () => {
    const terminals = createTerminalHost();
    try {
      const output: string[] = [];
      let exited = false;
      terminals.subscribe((event) => {
        if (event.type === 'data') output.push(event.data);
        else exited = true;
      });

      const info = await terminals.start({ cwd: process.cwd(), cols: 80, rows: 24 });
      expect(info.shell).toMatch(/\/(zsh|bash|sh|fish|dash|ksh)$/);

      /*
       * Let the shell finish saying hello before speaking to it. This spawns
       * the developer's real login shell, and input written while a heavy zsh
       * config is still evaluating its dotfiles can be half-swallowed by
       * line-editor initialisation — the first command runs, the `exit` line
       * vanishes, and the test times out on exactly the machines whose shells
       * take longest to start. "Settled" is output that has arrived and then
       * stayed still for one sample interval; the write races nothing after
       * that.
       */
      const settleDeadline = Date.now() + 10_000;
      let lastSeen = -1;
      while (Date.now() < settleDeadline) {
        const seen = output.join('').length;
        if (seen > 0 && seen === lastSeen) break;
        lastSeen = seen;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      terminals.write(info.id, 'printf ARTEMIS_PTY_OK\rexit\r');

      const deadline = Date.now() + 15_000;
      while (!exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(exited).toBe(true);
      // The shell echoes the command as well as running it, so the marker
      // appears twice — which is itself proof that this is a terminal (a pipe
      // would not echo) rather than a `child_process` in disguise.
      expect(output.join('')).toContain('ARTEMIS_PTY_OK');
    } finally {
      terminals.disposeAll();
    }
  });
});
