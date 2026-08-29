/**
 * The live xterm instances, held outside React.
 * ============================================================================
 *
 * This is to a terminal what `TranscriptModel` is to a conversation, and it
 * exists for the same reason stated there: **the stream must not pass through
 * React state.** A busy `pnpm build` emits sixty batches a second, and a
 * `setState` per batch would re-render the dock, the strip and every sibling
 * sixty times a second to update a canvas that xterm was going to repaint
 * anyway. So the store holds a *record* of each terminal — its id, its owner,
 * what its tab says — and this holds the thing that actually draws.
 *
 * ## The parking lot, and why the element is never unmounted
 *
 * A terminal's tab disappears whenever its conversation leaves the screen, and
 * comes back with it, with scrollback intact. That requirement rules out the
 * obvious implementation — an `<div ref>` that xterm attaches to — because
 * React would unmount the div and the `Terminal` would go with it.
 *
 * The three ways to keep one alive are not equal:
 *
 *  - **Detach the element** (`element.remove()`), re-append later. xterm cannot
 *    measure a detached node: `offsetWidth` is 0, so a `fit()` while detached
 *    computes a nonsense size, and any output that arrives meanwhile is laid
 *    out against it.
 *  - **`display: none`.** Same problem, same reason — a hidden element has no
 *    box.
 *  - **Park it off-screen, still laid out.** It keeps a real size, keeps
 *    rendering correctly into its own canvas, and re-attaching is one
 *    `appendChild` that *moves* a live node. Scrollback, selection, cursor
 *    position and viewport all survive, because none of them was ever
 *    re-created.
 *
 * The third is what this does. {@link parkingLot} is a fixed-size box pinned
 * far off the left edge — not `display:none`, deliberately — and every host
 * element lives either there or in a visible slot, never nowhere.
 *
 * ## Attaching is a move, not a mount
 *
 * {@link attachTerminal} appends an element that already exists into whatever
 * slot the component gives it. React never owns it, never diffs it, and never
 * recreates it. The component's cleanup puts it back in the parking lot rather
 * than destroying it — {@link disposeTerminalSession} is the only thing that
 * destroys one, and only `closeTerminal` calls that.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TerminalId } from '@rx-artemis/protocol';

import { call, resolveBridge } from './bridge';

/* -------------------------------------------------------------------------- */
/* Appearance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read one design token off the document.
 *
 * xterm paints into a canvas and cannot use CSS custom properties, so the
 * palette has to be handed to it as literal colours. Reading them from the
 * stylesheet rather than repeating them here is what keeps a terminal in the
 * same palette as the rest of the app when `index.css` changes — the one source
 * of truth that file claims to be.
 */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * Artemis's palette, as xterm wants it.
 *
 * The sixteen ANSI slots are mapped onto the five semantic hues `index.css`
 * defines rather than onto a generic terminal palette, so a `git diff` in here
 * is the same green and red as a diff in the transcript. The bright variants are
 * the same hues — this palette has one value per meaning on purpose, and
 * inventing eight more to fill the slots would be inventing colour policy in a
 * file that has no business setting it.
 */
function artemisTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  /*
   * The literals only fire where `getComputedStyle` has nothing to say — a
   * window with no stylesheet, which in practice means a test. They are the
   * dark palette's tokens resolved to sRGB (via `lib/oklch.ts`, the same
   * conversion `palette.test.ts` trusts), and they have to be re-resolved
   * when `index.css` moves: a stale fallback is the old palette frozen into
   * this file, which is exactly what reading the stylesheet was meant to
   * prevent.
   */
  const ink = token('--ink', '#f4f5f6');
  const abyss = token('--abyss', '#020203');
  const mint = token('--mint', '#6ce98d');
  const amber = token('--amber', '#fcc53f');
  const cyan = token('--cyan', '#8cc3fc');
  const beam = token('--beam', '#31eee8');
  const sage = token('--sage', '#93879c');
  const signal = token('--signal', '#fa6863');
  const faint = token('--ink-faint', '#7e8083');

  /*
   * ANSI 0 and 7 are the ends of the greyscale, and they do not follow the
   * tokens across a palette swap.
   *
   * `--ink` and `--abyss` are always at opposite ends, so mapping black to
   * `--abyss` and white to `--ink` is right in dark and exactly inverted in
   * light: a program printing in ANSI black would get `--abyss`, which under
   * the light palette is a near-white, on a near-white pane. Invisible output
   * is a bad way to find out the terminal was not part of "light mode".
   *
   * So the two are picked by which end they need to be rather than by name.
   * Read off the class on `<html>` rather than from the store, for the reason
   * `token` reads the stylesheet: the document is the source of truth this
   * module already trusts, and importing the store from here would close an
   * import cycle — the store imports this file.
   */
  const isLight = document.documentElement.classList.contains('light');
  const [ansiBlack, ansiWhite] = isLight ? [ink, abyss] : [abyss, ink];

  return {
    // Transparent, so the pane's own `bg-panel` shows through and a terminal
    // sits on the app's surface rather than punching a black rectangle in it.
    background: 'rgba(0,0,0,0)',
    foreground: ink,
    cursor: beam,
    cursorAccent: token('--panel', '#070708'),
    // Mixed from the accent rather than the literal `rgba(185,169,240,0.28)`
    // this was, which is the *dark* beam frozen into a number — under the
    // light palette it stayed a pale lavender while every other selection in
    // the app moved. Same 28%, same source of truth as `::selection`.
    selectionBackground: `color-mix(in oklch, ${beam} 28%, transparent)`,
    black: ansiBlack,
    red: signal,
    green: mint,
    yellow: amber,
    blue: cyan,
    magenta: beam,
    cyan: cyan,
    white: ansiWhite,
    brightBlack: faint,
    brightRed: signal,
    brightGreen: sage,
    brightYellow: amber,
    brightBlue: cyan,
    brightMagenta: beam,
    brightCyan: cyan,
    brightWhite: ansiWhite,
  };
}

/**
 * Repaint every live terminal in the current palette.
 *
 * xterm draws into a canvas and was handed literal colours when it was built,
 * so it is the one surface in the app a stylesheet swap does not reach — a
 * terminal left alone across a theme change keeps the palette it was born with
 * until it is destroyed. Assigning `options.theme` is xterm's supported way to
 * change it in place and forces a full repaint, so scrollback already on screen
 * moves too rather than only new output.
 *
 * Called by `setTheme` in the store, and by the media-query listener behind
 * "System". Terminals are rare and this is cheap; there is no attempt to skip
 * the work when the resolved palette has not actually changed, because the
 * callers only fire on a real change.
 */
export function retheme(): void {
  // Nothing to repaint, and — since `artemisTheme` reads the document — nothing
  // to read it from either. The store calls this on every theme change, and the
  // store is imported by Node-environment tests that have no `document`.
  if (sessions.size === 0) return;
  const theme = artemisTheme();
  for (const session of sessions.values()) session.term.options.theme = theme;
}

/**
 * The off-screen home for terminals with nowhere on screen to be.
 *
 * That is narrower than "not the active tab". An inactive tab's terminal stays
 * in its own hidden slot in the dock — see `DockPane` — and only comes here when
 * its *conversation* leaves the screen and `TerminalView` unmounts entirely.
 *
 * Sized rather than collapsed, for the reason in the file header: a box with no
 * dimensions is a terminal that cannot measure itself. The numbers are
 * arbitrary — anything plausible works, since {@link fitTerminal} recomputes on
 * every attach — and are only here so a parked terminal keeps laying out
 * against something sane.
 */
let parkingLot: HTMLDivElement | null = null;

function lot(): HTMLDivElement {
  if (parkingLot !== null) return parkingLot;
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText =
    'position:fixed;left:-10000px;top:0;width:800px;height:600px;overflow:hidden;pointer-events:none;';
  document.body.appendChild(element);
  parkingLot = element;
  return element;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export interface TerminalSession {
  readonly id: TerminalId;
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** The element xterm drew into. Moved between the lot and a visible slot. */
  readonly host: HTMLDivElement;
  dispose(): void;
}

const sessions = new Map<TerminalId, TerminalSession>();

/** Callbacks the store installs once, so this module need not import it. */
export interface TerminalSessionHooks {
  readonly onTitle: (id: TerminalId, title: string) => void;
}

let hooks: TerminalSessionHooks = { onTitle: () => undefined };

/** Wire this module to the store. Called once, from `bootstrap`. */
export function setTerminalSessionHooks(next: TerminalSessionHooks): void {
  hooks = next;
}

/**
 * The session for a terminal, creating it on first ask.
 *
 * Idempotent, which is what lets a component call it on every mount without
 * caring whether it is the first: a terminal that has been on screen before
 * comes back as the same object, still holding everything it has printed.
 *
 * `replay` is the seed for a session that has *never* been on screen in this
 * window — the first paint after a reload, where the shell has been running
 * without anyone drawing it. It is deliberately not applied to an existing
 * session, which already has the same bytes.
 */
export function ensureTerminalSession(id: TerminalId, replay?: string): TerminalSession {
  const existing = sessions.get(id);
  if (existing !== undefined) return existing;

  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%;';
  lot().appendChild(host);

  const term = new Terminal({
    cursorBlink: true,
    // The app's own mono face, so a terminal and a code block in the transcript
    // are set in the same type.
    fontFamily: token('--font-mono', 'ui-monospace, monospace'),
    fontSize: 12,
    lineHeight: 1.3,
    // Deep enough to be worth scrolling, bounded so a runaway build does not
    // become the window's memory. Main's replay tail is far smaller and does a
    // different job — this is what the user can actually scroll back through,
    // that is what survives a reload.
    scrollback: 10_000,
    theme: artemisTheme(),
    // Required for the transparent background in `artemisTheme`: without it
    // xterm composites onto an opaque layer and the pane's own surface never
    // shows through.
    allowTransparency: true,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  if (replay !== undefined && replay !== '') term.write(replay);

  term.onTitleChange((title) => hooks.onTitle(id, title));

  /*
   * Input goes straight out, unbuffered and unexamined.
   *
   * `onData` is xterm's already-encoded byte stream — a keystroke, a paste, an
   * arrow key's escape sequence — and this is deliberately not the place to
   * interpret any of it. A terminal that second-guessed `` (Ctrl-C) or `\x04`
   * (Ctrl-D) on the way past would be a terminal with opinions about which of
   * the user's keys reach their shell.
   */
  const typed = term.onData((data) => {
    const { bridge } = resolveBridge();
    if (!bridge) return;
    void call(() => bridge.terminal.write({ id, data }));
  });

  const session: TerminalSession = {
    id,
    term,
    fit,
    host,
    dispose() {
      typed.dispose();
      term.dispose();
      host.remove();
      sessions.delete(id);
    },
  };
  sessions.set(id, session);
  return session;
}

/** Write output into a terminal, if this window is holding one for it. */
export function writeToTerminal(id: TerminalId, data: string): void {
  sessions.get(id)?.term.write(data);
}

/**
 * Move a terminal's element into a visible slot.
 *
 * Returns the session so the caller can fit and focus it. `appendChild` on a
 * node that is already in the document *moves* it, which is the whole trick —
 * see the file header.
 */
export function attachTerminal(id: TerminalId, slot: HTMLElement): TerminalSession | null {
  const session = sessions.get(id);
  if (session === undefined) return null;
  if (session.host.parentElement !== slot) slot.appendChild(session.host);
  // A focus asked for before this element existed — the ⌘J case. Redeemed here
  // rather than taken unconditionally; see `requestTerminalFocus`.
  if (pendingFocus === id) {
    pendingFocus = null;
    session.term.focus();
  }
  return session;
}

/** Put a terminal's element back in the parking lot. It keeps running. */
export function detachTerminal(id: TerminalId): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  lot().appendChild(session.host);
}

/**
 * Re-measure a terminal and tell the shell its new size.
 *
 * The two halves have to happen together and in this order: `fit()` changes
 * what xterm *renders*, and the `resize` call is what makes the program on the
 * other end agree. Skipping the second gives a shell drawing an 80-column
 * prompt into a 120-column box.
 *
 * A no-op when the size has not changed, because `ResizeObserver` fires for
 * reasons that are not a size change — a scrollbar appearing, a font loading —
 * and a `SIGWINCH` per frame makes some full-screen programs flicker.
 */
export function fitTerminal(id: TerminalId): void {
  const session = sessions.get(id);
  if (session === undefined) return;

  const before = { cols: session.term.cols, rows: session.term.rows };
  try {
    session.fit.fit();
  } catch {
    // `fit` reads layout, and a slot mid-transition can report a zero box. The
    // observer will call again when it settles.
    return;
  }

  const { cols, rows } = session.term;
  if (cols === before.cols && rows === before.rows) return;
  if (cols < 1 || rows < 1) return;

  const { bridge } = resolveBridge();
  if (!bridge) return;
  void call(() => bridge.terminal.resize({ id, cols, rows }));
}

/** Put the caret in a terminal, now, if it is somewhere it can be seen. */
export function focusTerminal(id: TerminalId): void {
  sessions.get(id)?.term.focus();
}

/**
 * Is the caret in this terminal right now?
 *
 * Asked by `toggleTerminal`, whose press means two different things depending
 * on the answer: "let me type into the shell" when the caret is elsewhere, and
 * "let me back out" when it is already there. xterm takes keys through a
 * hidden textarea inside the host, so containment is the whole test — and a
 * parked host cannot contain the document's active element, which makes "not
 * on screen" answer no without a special case.
 */
export function terminalHasFocus(id: TerminalId): boolean {
  const session = sessions.get(id);
  if (session === undefined) return false;
  const active = document.activeElement;
  return active !== null && session.host.contains(active);
}

/**
 * Ask for the caret, once the terminal is actually on screen.
 *
 * Focus is **requested**, never taken on mount, and the difference is the whole
 * point of this function. A terminal's element mounts whenever its conversation
 * comes back to the screen — clicking a row in the sidebar, closing the pane
 * beside it — and a focus in that effect would mean the shell quietly stealing
 * the caret from the composer every time you glanced away and back. The next
 * thing typed would go to bash.
 *
 * So focus follows the two things that are unambiguously a request for it:
 * opening a terminal, and clicking its tab. Both call this.
 *
 * Deferred twice over, because "on screen" arrives later than the request in two
 * different ways. Clicking a tab writes state that React has not rendered yet,
 * so the element is still `hidden` this tick — hence the frame. Opening a new
 * terminal has no element at all yet, since `TerminalView` has not mounted —
 * hence the pending id, which {@link attachTerminal} redeems.
 */
let pendingFocus: TerminalId | null = null;

export function requestTerminalFocus(id: TerminalId): void {
  pendingFocus = id;
  if (typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    if (pendingFocus !== id) return;
    const session = sessions.get(id);
    // Still parked, or not mounted: leave it pending for `attachTerminal`.
    if (session === undefined || session.host.parentElement === parkingLot) return;
    pendingFocus = null;
    session.term.focus();
  });
}

/**
 * Say that a shell has ended, in the terminal itself.
 *
 * Written into the buffer rather than rendered as a React banner over it,
 * because it belongs in the scroll position it happened at — under the last
 * thing the program printed, which is usually the reason it ended.
 */
export function noteTerminalExit(id: TerminalId, exitCode: number, signal?: number): void {
  const session = sessions.get(id);
  if (session === undefined) return;
  const why =
    signal !== undefined && signal !== 0
      ? `killed by signal ${String(signal)}`
      : `exited with status ${String(exitCode)}`;
  session.term.write(`\r\n[38;5;245m[${why}][0m\r\n`);
}

/**
 * Destroy a terminal's session. Only `closeTerminal` calls this.
 *
 * Everything else that makes a tab disappear leaves the session alive in the
 * parking lot — that is the point of the parking lot.
 */
export function disposeTerminalSession(id: TerminalId): void {
  sessions.get(id)?.dispose();
}
