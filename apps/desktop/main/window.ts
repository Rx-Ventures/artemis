/**
 * The window's chrome.
 * ============================================================================
 *
 * Artemis hides the platform's title bar and draws its own, so this module owns
 * the two halves of that trade: the options that take the native bar away, and
 * the state feed the renderer needs once it is gone.
 *
 * ## Why hide it at all
 *
 * A native title bar is a strip of the window that can hold nothing. Under it
 * Artemis already draws a bar that names the project and the session and carries
 * the sidebar toggle, new session and settings — so a framed window spends
 * ~28px saying "Artemis" above a bar that says something useful. Hiding it makes
 * the app's own header *be* the title bar: same drag behaviour, same
 * double-click-to-zoom, one row instead of two.
 *
 * ## `hidden`, not `hiddenInset`
 *
 * Both hide the bar and keep macOS's traffic lights. `hiddenInset` also picks
 * the lights' position for you, centred for a standard-height bar — which is
 * not the height of ours. `hidden` leaves the position to
 * {@link TRAFFIC_LIGHT_POSITION}, so the buttons sit on the header's optical
 * centre line rather than near its top edge.
 *
 * On Windows and Linux the same value hides the bar *and* its buttons, which is
 * the intent: there is no system-drawn control to inherit there, so the renderer
 * draws minimize, maximize and close itself and reaches back through
 * `IPC.window*`. It is deliberately not `frame: false` — `hidden` keeps
 * `WS_THICKFRAME`, and with it the drop shadow, the resize-by-edge and the snap
 * behaviour that a frameless Windows window otherwise loses.
 *
 * ## The state feed
 *
 * Everything about a window's chrome is invisible from inside the page: no DOM
 * event fires when the user maximizes, and full screen is not
 * `document.fullscreenElement`. So {@link forwardWindowState} pushes it, and
 * the header renders from that rather than guessing at `outerHeight`.
 */

import type { EventEmitter } from 'node:events';

import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { IPC_PUSH, type Unsubscribe, type WindowState } from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('window');

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The header's height in CSS pixels.
 *
 * **Kept in sync by hand with `h-11` on the `<header>` in
 * `renderer/src/components/AppHeader.tsx`.** The main process cannot read a
 * Tailwind class and the renderer cannot place a traffic light, so the number
 * exists in both files and this comment is the link between them — the same
 * arrangement, and for the same reason, as `APP_USER_MODEL_ID` and the
 * builder's `appId`. Change one, change the other, or macOS's buttons stop
 * lining up with the controls beside them.
 */
const HEADER_HEIGHT = 44;

/** Diameter of a macOS window button. Fixed by AppKit, not by us. */
const TRAFFIC_LIGHT_DIAMETER = 12;

/**
 * Where the traffic lights go, as the top-left of the three-button group.
 *
 * Vertically centred in the header by construction, so the buttons stay on the
 * same line as the icon buttons to their right if the bar's height ever
 * changes. Horizontally, 16px is the inset AppKit itself uses on a toolbar
 * window — near enough to Finder that it does not read as an app that got it
 * slightly wrong.
 */
const TRAFFIC_LIGHT_POSITION = {
  x: 16,
  y: Math.round((HEADER_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2),
} as const;

/**
 * The window options that take the native title bar away.
 *
 * Spread into the `BrowserWindow` constructor. Split out from `index.ts` so
 * that "how the window is dressed" and "when the window is created" are not the
 * same paragraph — and so the reasoning above sits next to the values it
 * explains.
 */
export function windowChromeOptions(): BrowserWindowConstructorOptions {
  // `trafficLightPosition` is darwin-only and ignored elsewhere, but it is
  // omitted rather than passed anyway: a Windows window carrying a macOS
  // button coordinate invites the reader to wonder what it does there.
  return process.platform === 'darwin'
    ? { titleBarStyle: 'hidden', trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } }
    : { titleBarStyle: 'hidden' };
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the window's chrome state.
 *
 * A destroyed window reports the state of no window at all — every field false
 * — rather than throwing. Callers reach this from an IPC handler racing a
 * closing window and from an event fired during teardown; neither has anything
 * useful to do with an exception, and "not maximized, not full screen, not
 * focused" is true of a window that is gone.
 */
export function readWindowState(window: BrowserWindow | null): WindowState {
  if (window === null || window.isDestroyed()) {
    return { maximized: false, fullScreen: false, focused: false };
  }
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused(),
  };
}

/**
 * Every window event that can change what {@link readWindowState} returns.
 *
 * `restore` and `resize` are in here for the cases the named events miss: a
 * window un-maximized by dragging its title bar on Windows resizes without
 * emitting `unmaximize` on every platform, and coming back from minimized
 * restores a maximized window without re-emitting `maximize`. The push is
 * deduplicated downstream, so listing an event that usually reports no change
 * costs nothing.
 */
const STATE_EVENTS = [
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
  'focus',
  'blur',
  'restore',
  'resize',
] as const;

/**
 * Push this window's chrome state to it whenever the state changes.
 *
 * Per-window, unlike `forwardAgentEvents`: agent events are the app's and go to
 * every window, but a window's own maximized-ness is nobody else's business,
 * and a second Artemis window must not redraw its restore icon because the first
 * one was zoomed.
 *
 * Deduplicated on the way out. `resize` fires on every frame of a drag, and all
 * but the first of those report a state identical to the last one sent — pushing
 * them would put an IPC message and a React render on each frame to say nothing
 * had changed.
 *
 * Returns a disposer. It is also safe to simply drop: the listeners live on the
 * window and die with it.
 */
export function forwardWindowState(window: BrowserWindow): Unsubscribe {
  let last: WindowState | null = null;

  const send = (): void => {
    if (window.isDestroyed()) return;

    const state = readWindowState(window);
    if (
      last !== null &&
      last.maximized === state.maximized &&
      last.fullScreen === state.fullScreen &&
      last.focused === state.focused
    ) {
      return;
    }
    last = state;

    const contents = window.webContents;
    if (contents.isDestroyed()) return;
    try {
      // Not scanned by `redact.ts`, unlike agent events and IPC responses.
      // Those carry data that passed through a profile or a provider; this is
      // three booleans built from three Electron calls one function above, and
      // there is no path by which a string could reach it.
      contents.send(IPC_PUSH.windowState, state);
    } catch (error) {
      // A window closing mid-send is routine, not exceptional.
      log.debug('Failed to deliver window state', error);
    }
  };

  // Subscribed through the base `EventEmitter` rather than `window.on`.
  // Electron types every window event as its own overload, so a call whose
  // event name is a *union* — which is what looping over `STATE_EVENTS`
  // produces — matches none of them. `BrowserWindow` extends `EventEmitter`,
  // whose signature takes any name, so widening is enough and no cast is
  // needed. All eight listeners take no arguments.
  const emitter: EventEmitter = window;
  for (const event of STATE_EVENTS) emitter.on(event, send);

  return () => {
    if (window.isDestroyed()) return;
    for (const event of STATE_EVENTS) emitter.off(event, send);
  };
}
