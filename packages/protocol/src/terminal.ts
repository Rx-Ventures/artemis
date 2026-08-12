/**
 * A terminal, as the two sides of the app have to agree on it.
 * ============================================================================
 *
 * A pseudo-terminal is a pair of file descriptors and a child process, and none
 * of that can cross IPC. What crosses is deliberately small: an **opaque id**, a
 * **stream of bytes in each direction**, and a **size**. Everything else — which
 * shell, what environment, where the process lives, when it is reaped — is the
 * main process's business and appears here only as the descriptive fields on
 * {@link TerminalInfo}, which exist so a tab can label itself.
 *
 * ## The id is minted by main, and that is a security property
 *
 * {@link TerminalId} is issued by `main/terminal.ts` and is only ever *echoed*
 * by the renderer. Nothing in this contract lets the renderer name a terminal it
 * was not given, and the main process resolves every id against its own registry
 * before acting — so "write these bytes to terminal X" cannot be aimed at a
 * terminal the caller was never handed, and cannot conjure one.
 *
 * That is the whole reason there is no `cwd` or `shell` on any request but
 * {@link TerminalStartRequest}. A write names a terminal, not a place.
 *
 * ## Why `data` is a string and not a `Uint8Array`
 *
 * Because the PTY is opened in UTF-8 mode and both ends of this pipe speak
 * UTF-8: node-pty decodes on the way out, xterm.js encodes on the way in. Moving
 * bytes instead would mean re-implementing multi-byte character reassembly at
 * the IPC seam — a chunk boundary can land in the middle of a `é` — which
 * node-pty already does correctly on the other side of it.
 *
 * ## What is not here
 *
 * No "run this command" channel, and there will not be one. The renderer writes
 * keystrokes into a shell; it does not name programs. A command channel would be
 * a second, weaker way to execute things whose validation would have to be as
 * careful as a shell's own quoting rules — and would still be reachable by
 * anything that could already write `\n` into a terminal.
 */

import type { TerminalId } from './ids.js';

/**
 * What a terminal is, once it exists.
 *
 * The three descriptive fields are for the tab strip, not for control flow:
 * `shell` and `cwd` say what a tab is *of*, which is the only way to tell two
 * terminals on the same project apart before either has printed anything.
 */
export interface TerminalInfo {
  readonly id: TerminalId;
  /** Absolute path of the shell that was spawned. Chosen by main; see `terminal.ts`. */
  readonly shell: string;
  /** Where it was started. A shell may `cd` away — this is not re-read. */
  readonly cwd: string;
  readonly startedAt: number;
  /**
   * True once the child has exited.
   *
   * The record outlives the process on purpose: a shell that dies — `exit`, a
   * failed spawn, a segfault — should leave its last words on screen rather
   * than having the tab vanish out from under whoever is reading them. The tab
   * closes when the user closes it.
   */
  readonly exited: boolean;
}

/** Output from a terminal, already decoded. Batched by main; see `terminal.ts`. */
export interface TerminalDataEvent {
  readonly type: 'data';
  readonly id: TerminalId;
  readonly data: string;
}

/**
 * A terminal's child process has ended.
 *
 * `exitCode` and `signal` are reported rather than interpreted: "killed by
 * SIGHUP because the user closed the tab" and "segfaulted" are the same shape
 * here, and the renderer is what decides whether either is worth saying.
 */
export interface TerminalExitEvent {
  readonly type: 'exit';
  readonly id: TerminalId;
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * Everything a terminal pushes at the renderer.
 *
 * One union on one push channel, demultiplexed on `id` — the same shape
 * {@link import('./events.js').AgentEvent} uses, and for the same reason: a
 * channel per terminal would force the preload to build channel names out of
 * renderer-supplied strings, which is precisely the pattern it forbids.
 */
export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

/** Every terminal event type, for the preload's shape check. */
export const TERMINAL_EVENT_TYPES = ['data', 'exit'] as const;

/**
 * Open a shell.
 *
 * `cols` and `rows` are required rather than defaulted because a terminal that
 * starts at the wrong size and is corrected a frame later has already told the
 * shell to draw its prompt at the wrong width — and a prompt drawn once is not
 * redrawn. The caller measures first, then starts.
 */
export interface TerminalStartRequest {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalStartResponse {
  readonly terminal: TerminalInfo;
}

/** Keystrokes, a paste, or a control sequence. Whatever the user typed. */
export interface TerminalWriteRequest {
  readonly id: TerminalId;
  readonly data: string;
}

export interface TerminalWriteResponse {
  readonly id: TerminalId;
}

/** The pane was resized. Becomes a `SIGWINCH` the running program can act on. */
export interface TerminalResizeRequest {
  readonly id: TerminalId;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalResizeResponse {
  readonly id: TerminalId;
}

/**
 * Kill a terminal and forget it.
 *
 * The only thing that ends a shell. Closing a pane, switching session and
 * reloading the window all leave it running — see `state/dock.ts` for why that
 * is the behaviour people actually want from a terminal.
 */
export interface TerminalCloseRequest {
  readonly id: TerminalId;
}

export interface TerminalCloseResponse {
  readonly id: TerminalId;
}

/**
 * Every terminal main is holding.
 *
 * The reload story, and the same shape `runs:list` provides for runs: a renderer
 * that has just been recreated has no idea what it was showing, and the
 * processes carried on without it.
 */
export interface TerminalListRequest {
  readonly unused?: never;
}

export interface TerminalListResponse {
  readonly terminals: readonly TerminalInfo[];
}

/**
 * The retained tail of a terminal's output.
 *
 * Bounded — see `MAX_REPLAY_BYTES` in `main/terminal.ts` — so this is "what is
 * still on screen", not "everything that ever happened". A terminal is a view
 * onto a running process, and scrollback that survives the window that was
 * showing it is a promise this deliberately does not make.
 */
export interface TerminalReplayRequest {
  readonly id: TerminalId;
}

export interface TerminalReplayResponse {
  readonly id: TerminalId;
  readonly data: string;
  /** True when output was dropped from the front to stay inside the bound. */
  readonly truncated: boolean;
}
