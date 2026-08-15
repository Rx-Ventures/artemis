/**
 * Pages, and the six things the renderer is allowed to do to one.
 * ============================================================================
 *
 * This is the only file in Artemis that renders content Artemis did not author
 * and cannot inspect: the open web, in a window the user is already trusting
 * with a filesystem-capable IPC bridge. That sentence is the design brief, and
 * everything below follows from taking it seriously.
 *
 * ## The containment is structural, not a policy
 *
 * A page opened here cannot reach Artemis, and the reason is not a rule that
 * could be forgotten — it is the absence of any wire between the two:
 *
 *  1. **No preload.** Every other `webContents` in this app is constructed with
 *     `preload/index.cjs`, which is what puts `window.artemis` on it. A page in
 *     this file is constructed without one, so there is no bridge object to
 *     find, no channel name to guess, and nothing for a compromised page to
 *     call. `ipcRenderer` is not reachable from a sandboxed context without a
 *     preload, so the surface is not "narrow", it is empty.
 *  2. **A sibling, not a frame.** The view is stacked on the window next to the
 *     renderer rather than nested inside it, so there is no parent document to
 *     walk up into and no shared origin to inherit. The renderer's DOM — the
 *     transcript, the user's prompts — is not in the page's world at all.
 *  3. **Its own session.** {@link BROWSER_PARTITION} keeps cookies, storage and
 *     caches away from Artemis's session, which matters in both directions: a
 *     site cannot read anything Artemis stored, and signing into a site here
 *     cannot be confused with the app's own credentials.
 *
 * ## The consequence of (3) that has to be said out loud
 *
 * `applySessionPolicy` in `security.ts` is applied to `session.defaultSession`.
 * A browser on its own partition therefore does **not** get Artemis's
 * Content-Security-Policy forced onto its responses — and that is deliberate,
 * because it has to be: Artemis's CSP is `script-src 'self'`, and applying it to
 * the web would render a blank page for every site in the world.
 *
 * So the app's hardening does not cover these pages, and this file sets its own.
 * What is here in its place is the list in {@link harden}: no permissions, no
 * downloads, no popups, no navigation outside `http(s)`. A page gets to be a
 * page — script, network, storage — and gets nothing that reaches the machine.
 *
 * ## Main owns the id, the lifetime and the geometry
 *
 * The same three facts `terminal.ts` states, plus one it does not need.
 * {@link BrowserHost.open} is the only source of a {@link BrowserId}; every
 * other method resolves the id it is given against the registry, so an id
 * nobody was handed matches nothing. A view dies when the tab is closed or the
 * app quits — not when a pane closes, not when the conversation changes.
 *
 * The extra one is **geometry**. A `WebContentsView` is not a DOM element, so
 * the renderer cannot lay it out; it measures a placeholder and sends the
 * rectangle. That makes the renderer able to *place* a page but never to read
 * one, which is the right split — a rectangle is not a capability.
 *
 * ## Hiding is detaching, and detaching is not closing
 *
 * A hidden browser is removed from the window's view tree, not moved off screen
 * or shrunk to nothing. A native view parked at negative coordinates still
 * composites and can still bleed through a rounded corner during a resize, and
 * one sized `0×0` makes some pages recalculate their layout to nothing and stay
 * that way when they come back. Removal is the only reliable hide.
 *
 * What it explicitly is not is a close: the `webContents` outlives the
 * detachment, so the page keeps running, keeps its scroll position and keeps
 * whatever was typed into it. That is the whole reason a browser is modelled on
 * a terminal rather than on a preview — see `protocol/browser.ts`.
 */

import { randomBytes } from 'node:crypto';

import {
  BrowserWindow as ElectronBrowserWindow,
  session as electronSession,
  shell,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron';

import {
  browserUrlFor,
  type BrowserBounds,
  type BrowserCommand,
  type BrowserEvent,
  type BrowserId,
  type BrowserInfo,
  type BrowserState,
  type RunId,
  type Unsubscribe,
} from '@rx-artemis/protocol';

import { createLogger } from './log.js';

const log = createLogger('browser');

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many pages may be open at once.
 *
 * Matches {@link import('./terminal.js').MAX_TERMINALS} and exists for the same
 * reason — a backstop against a renderer loop, not a product decision. A page is
 * a great deal more expensive than a shell, though: each one is a renderer
 * process with its own compositor, so this ceiling is doing more work here than
 * the terminal's does there.
 */
export const MAX_BROWSERS = 8;

/**
 * The session every page in this app shares.
 *
 * `persist:` so that signing into a documentation site or a staging environment
 * survives a restart, which is the difference between a browser and a viewer.
 * One partition for all of them rather than one each: tabs in a browser share
 * cookies, that is what makes them a browser, and isolating them from *Artemis*
 * is the boundary that matters — see the file header.
 */
const BROWSER_PARTITION = 'persist:artemis-browser';

/** Longest page title kept. Untrusted display text; a page chooses this. */
const MAX_TITLE = 300;

/** Longest URL kept, matching the protocol's own bound. */
const MAX_URL = 4_096;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

interface BrowserRecord {
  readonly id: BrowserId;
  readonly view: WebContentsView;
  readonly window: BrowserWindow;
  readonly openedAt: number;
  /** Whether the view is currently a child of the window's content view. */
  attached: boolean;
  state: BrowserState;
}

/** What a `BrowserHost` hands out. Kept small on purpose; see the header. */
export interface BrowserHostOptions {
  /** Overridable so a test can supply a session that is not Electron's. */
  readonly partition?: string;
}

/* -------------------------------------------------------------------------- */
/* The host                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every page Artemis has open, and the only way to make another.
 *
 * Deliberately mirrors `TerminalHost`'s shape — `open`/`close`/`list`/
 * `subscribe` — so the dock's two live surfaces are the same kind of object to
 * everything above them.
 */
export class BrowserHost {
  readonly #browsers = new Map<BrowserId, BrowserRecord>();
  /** Which browser each run's agent is driving. See {@link agentBrowserFor}. */
  readonly #agentBrowsers = new Map<RunId, BrowserId>();
  readonly #listeners = new Set<(event: BrowserEvent) => void>();
  readonly #partition: string;
  #session: Session | null = null;

  constructor(options: BrowserHostOptions = {}) {
    this.#partition = options.partition ?? BROWSER_PARTITION;
  }

  /**
   * Open a page.
   *
   * `window` is the window the view is stacked on, and it comes from the IPC
   * layer's `HandlerContext` rather than from the request — so the renderer
   * says "a browser", and main decides which window that means. A second
   * Artemis window cannot be given a browser by the first.
   */
  open(window: BrowserWindow, query: string | undefined): BrowserInfo {
    if (this.#browsers.size >= MAX_BROWSERS) {
      throw new Error(`Artemis can keep ${String(MAX_BROWSERS)} browsers open at once.`);
    }

    const url = query === undefined ? null : browserUrlFor(query);
    if (query !== undefined && url === null) {
      throw new Error(refusalFor(query));
    }

    const view = new WebContentsView({ webPreferences: this.#preferences() });
    /*
     * A page that sets no background of its own composites as transparent,
     * which shows the app's chrome through the middle of a document. White is
     * what a browser does — and deliberately not a theme token: this is the
     * canvas a *web page* paints on, not a surface of Artemis's, and tinting it
     * would mean every page with a transparent background rendered in a colour
     * its author never chose.
     */
    view.setBackgroundColor('#ffffff');
    const id = randomBytes(16).toString('hex') as BrowserId;

    const record: BrowserRecord = {
      id,
      view,
      window,
      openedAt: Date.now(),
      attached: false,
      state: { url: url ?? '', title: '', loading: url !== null, canGoBack: false, canGoForward: false },
    };
    this.#browsers.set(id, record);

    this.#harden(record);
    this.#watch(record);

    if (url !== null) void this.#load(record, url);
    return infoOf(record);
  }

  /** Go somewhere. Returns the URL the query actually resolved to. */
  navigate(id: BrowserId, query: string): string {
    const record = this.#require(id);
    const url = browserUrlFor(query);
    if (url === null) throw new Error(refusalFor(query));
    void this.#load(record, url);
    return url;
  }

  /** Back, forward, reload, stop. Ignored when the action is unavailable. */
  command(id: BrowserId, command: BrowserCommand): void {
    const contents = this.#require(id).view.webContents;
    switch (command) {
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        return;
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        return;
      case 'reload':
        contents.reload();
        return;
      default:
        contents.stop();
    }
  }

  /**
   * Put the page somewhere, or take it off screen.
   *
   * Called on every frame of a drag-resize, so it does as little as possible:
   * bounds are rounded to whole pixels (Electron requires integers, and a
   * fractional rectangle silently truncates in a direction that leaves a seam),
   * and the attach/detach only runs when the answer actually changed.
   */
  layout(id: BrowserId, bounds: BrowserBounds, visible: boolean): void {
    const record = this.#require(id);
    if (record.window.isDestroyed()) return;

    record.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });

    if (visible === record.attached) return;
    if (visible) record.window.contentView.addChildView(record.view);
    else record.window.contentView.removeChildView(record.view);
    record.attached = visible;
  }

  /** Destroy a page. The only thing that ends one. */
  close(id: BrowserId): void {
    const record = this.#browsers.get(id);
    if (record === undefined) return;
    this.#browsers.delete(id);
    this.#destroy(record);
  }

  list(): readonly BrowserInfo[] {
    return [...this.#browsers.values()].map(infoOf);
  }

  subscribe(listener: (event: BrowserEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Tear every page down. Called on quit. */
  disposeAll(): void {
    for (const record of this.#browsers.values()) this.#destroy(record);
    this.#browsers.clear();
    this.#listeners.clear();
  }

  /* ------------------------------------------------------------------ */
  /* For the agent's tools only — never reachable over IPC              */
  /* ------------------------------------------------------------------ */

  /**
   * The live `webContents` behind an id.
   *
   * Exists for `browserTools.ts`, which drives a page on the agent's behalf and
   * needs to read it. **Nothing on the IPC surface calls this**, and that is the
   * boundary worth keeping: the renderer can place a page and navigate it, and
   * only main-process code can look inside one.
   *
   * Returns `null` rather than throwing for an id that has gone, because a tool
   * call racing a closed tab is ordinary rather than exceptional.
   */
  contentsFor(id: BrowserId): WebContents | null {
    const record = this.#browsers.get(id);
    if (record === undefined || record.view.webContents.isDestroyed()) return null;
    return record.view.webContents;
  }

  /** The state a tool would report, without reaching for `webContents`. */
  stateFor(id: BrowserId): BrowserState | null {
    return this.#browsers.get(id)?.state ?? null;
  }

  /**
   * The browser an agent is driving for one run, or `null`.
   *
   * Ownership is tracked here rather than in the renderer because the agent's
   * tools run in main and the renderer may not even be listening — a window
   * mid-reload still has an agent making tool calls. The renderer learns about
   * an agent's browser from the `opened` event and draws a tab for it.
   */
  agentBrowserFor(runId: RunId): BrowserId | null {
    const id = this.#agentBrowsers.get(runId);
    if (id === undefined) return null;
    // A tab the user closed leaves the run without one, which is the honest
    // answer: the next `browser_open` makes a new one rather than resurrecting
    // a view the user deliberately shut.
    if (!this.#browsers.has(id)) {
      this.#agentBrowsers.delete(runId);
      return null;
    }
    return id;
  }

  /**
   * Open a page on an agent's behalf, or bring the one it has to the address.
   *
   * The window is chosen here rather than passed in, because a tool call has no
   * window context — it arrives from a subprocess, through the SDK, with only a
   * run id. The first open window is the right answer for the case that exists
   * (one window) and a defensible one for the case that does not.
   */
  async openForAgent(runId: RunId, url: string | undefined): Promise<BrowserId> {
    const existing = this.agentBrowserFor(runId);
    if (existing !== null) {
      if (url !== undefined) this.navigate(existing, url);
      return existing;
    }

    const window = firstWindow();
    if (window === null) throw new Error('Artemis has no window to open a browser in.');

    const info = this.open(window, url);
    this.#agentBrowsers.set(runId, info.id);
    // The renderer has no idea this exists — it did not ask for it. This event
    // is what puts a tab in the strip, which is what makes the agent's browsing
    // something the user watches rather than something that happens off screen.
    this.#emit({ type: 'opened', id: info.id, browser: info, runId });
    return info.id;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  #require(id: BrowserId): BrowserRecord {
    const record = this.#browsers.get(id);
    if (record === undefined) throw new Error('That browser is no longer open.');
    return record;
  }

  /**
   * The session every page shares, created on first use.
   *
   * Lazy because `session.fromPartition` requires `app.whenReady()`, and a host
   * may be constructed during bootstrap before that has resolved.
   */
  #sessionFor(): Session {
    if (this.#session !== null) return this.#session;
    const created = electronSession.fromPartition(this.#partition);
    this.#session = created;

    /*
     * Session-level hardening, installed exactly once.
     *
     * This lives here rather than in {@link harden} because it belongs to the
     * *session*, and the session outlives any one view. Running it per view
     * would re-set the two permission handlers harmlessly and add a second
     * `will-download` listener every time a tab was opened — a leak whose only
     * symptom is the log line appearing twice, then eight times, which is
     * exactly the kind of bug that is never noticed.
     */

    // A page asking for camera, microphone, geolocation, notifications, MIDI or
    // any of the rest. All refused, and refused *silently* — a prompt would be
    // Artemis asking the user to grant something on a site's behalf, and the app
    // has no standing to broker that. A site that genuinely needs a webcam is a
    // site to open in a real browser.
    created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    created.setPermissionCheckHandler(() => false);

    // Downloads. Blocked, because a download is a page writing to the disk of a
    // machine it reached through a coding tool, and there is nowhere in this UI
    // to show one that the user could reason about. A known gap rather than a
    // finished answer: the honest fix is a downloads surface, and until there is
    // one this is the safe direction to fail in.
    created.on('will-download', (event) => {
      event.preventDefault();
      log.info('Blocked a download from an embedded browser.');
    });

    return created;
  }

  /**
   * What a browsed page is allowed to be.
   *
   * Note what is *not* here: no `preload`. That single omission is most of this
   * file's security story — see the header. The rest is Electron's own
   * hardening flags, set explicitly rather than relied on as defaults, because
   * a default that changes in a future major is not something to discover by
   * reading a CVE.
   */
  #preferences(): Electron.WebPreferences {
    return {
      session: this.#sessionFor(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    };
  }

  /**
   * Everything one page may not do.
   *
   * Per view, because these are `webContents` handlers and a `webContents` is
   * what a view has. The session-level half — permissions and downloads — is in
   * {@link sessionFor}, installed once, for reasons written out there.
   */
  #harden(record: BrowserRecord): void {
    const contents = record.view.webContents;

    /*
     * `target="_blank"`, `window.open`, and everything else that wants a second
     * window. Never granted: a popup would be an Electron window with no chrome,
     * no address bar and no way to tell what it is. An http(s) link navigates
     * the view the user is already looking at; anything else goes to the real
     * browser, where the OS decides what a `mailto:` means.
     */
    contents.setWindowOpenHandler(({ url }) => {
      if (browserUrlFor(url) !== null) void this.#load(record, url);
      else void shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });

    /*
     * Navigation to something that is not the web. Chromium blocks most of these
     * from an http origin already; this is the belt to that braces, and it is
     * what makes {@link BROWSER_SCHEMES} true of the whole session rather than
     * only of the address bar.
     */
    contents.on('will-navigate', (event, url) => {
      if (browserUrlFor(url) === null) {
        event.preventDefault();
        log.info('Blocked an embedded browser from leaving http(s).');
      }
    });

    // A page cannot attach a `<webview>` — `webviewTag` is already false, so
    // this should be unreachable and is here as the tripwire for the day it is
    // not, exactly as `security.ts` does for the renderer.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      log.error('An embedded browser tried to attach a webview.');
    });
  }

  /** Wire a view's navigation events to the push channel. */
  #watch(record: BrowserRecord): void {
    const contents = record.view.webContents;
    const push = (patch: Partial<BrowserState>): void => this.#update(record, patch);

    contents.on('did-start-loading', () => push({ loading: true }));
    contents.on('did-stop-loading', () => push({ loading: false }));
    contents.on('page-title-updated', (_event, title) => push({ title: clamp(title, MAX_TITLE) }));

    const navigated = (): void =>
      push({ url: clamp(contents.getURL(), MAX_URL), failure: undefined });
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', navigated);

    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // Subframe failures are the ad blocker's business, not the address bar's.
      // `-3` is ABORTED, which is what a navigation the user replaced reports.
      if (!isMainFrame || code === -3) return;
      push({ loading: false, failure: failureFor(code, description, url) });
    });

    contents.on('render-process-gone', (_event, details) => {
      this.#browsers.delete(record.id);
      this.#destroy(record);
      this.#emit({ type: 'gone', id: record.id, reason: details.reason });
    });
  }

  /** Fold a patch into a record's state and tell the renderer. */
  #update(record: BrowserRecord, patch: Partial<BrowserState>): void {
    const contents = record.view.webContents;
    if (contents.isDestroyed()) return;

    const merged = { ...record.state, ...patch };
    // An explicit `failure: undefined` in a patch means "clear it", which is
    // what a fresh navigation sends. Spreading leaves the key present and set to
    // `undefined`, and a key that exists is not the same as one that does not
    // once this crosses `structuredClone` — so it is deleted rather than left.
    if ('failure' in patch && patch.failure === undefined) delete merged.failure;

    const next: BrowserState = {
      ...merged,
      // A page that has not offered a title is captioned by its host, which is
      // what a tab strip needs and what every browser does.
      title: merged.title.length > 0 ? merged.title : (hostOf(merged.url) ?? merged.url),
      /*
       * Re-read rather than tracked. There is no event for "the back button
       * became available" — it changes as a side effect of navigations that
       * have their own events, and deriving it here is cheaper than getting
       * that bookkeeping subtly wrong.
       */
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };

    record.state = next;
    this.#emit({ type: 'state', id: record.id, state: next });
  }

  async #load(record: BrowserRecord, url: string): Promise<void> {
    this.#update(record, { loading: true, failure: undefined });
    try {
      await record.view.webContents.loadURL(url);
    } catch (error) {
      /*
       * `loadURL` rejects on a navigation that was replaced as well as on one
       * that failed, and the two are indistinguishable here. `did-fail-load`
       * has already reported anything worth reporting with a code that can be
       * told apart, so this only has to not become an unhandled rejection.
       */
      log.debug(`Navigation to ${url} did not complete`, error);
    }
  }

  #destroy(record: BrowserRecord): void {
    try {
      if (record.attached && !record.window.isDestroyed()) {
        record.window.contentView.removeChildView(record.view);
      }
      if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    } catch (error) {
      log.debug('Failed to tear down a browser view', error);
    }
  }

  #emit(event: BrowserEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        log.debug('A browser event listener threw', error);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A window to stack an agent's view on.
 *
 * `getAllWindows()[0]` rather than the focused one: an agent works while the
 * user is elsewhere, and "focused" is routinely `null` — which would make the
 * tool fail for the reason it is most useful.
 */
function firstWindow(): BrowserWindow | null {
  return ElectronBrowserWindow.getAllWindows().find((one) => !one.isDestroyed()) ?? null;
}

function infoOf(record: BrowserRecord): BrowserInfo {
  return { id: record.id, openedAt: record.openedAt, state: record.state };
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** The host of a URL, for captioning a page that offered no title. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * What to say when a query is not an address.
 *
 * Written for the person who typed it, and specifically **not** a restatement
 * of the rule: "must match ^https?://" tells a user nothing they can act on.
 * The two cases it distinguishes are the two that actually happen — a scheme
 * this refuses, and prose that was meant for a search engine there isn't one of.
 */
function refusalFor(query: string): string {
  const trimmed = query.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !/^https?:/i.test(trimmed)) {
    return `Artemis's browser opens http and https addresses. ${trimmed.split(':', 1)[0] ?? ''}: is not one of them.`;
  }
  return `“${clamp(trimmed, 80)}” is not an address. Type a URL — there is no search box here.`;
}

/**
 * Chromium's error name, turned into a sentence.
 *
 * Only the handful anyone actually meets. Everything else falls through to the
 * raw description, which is ugly but true — inventing a friendly sentence for
 * an error nobody predicted is how a UI ends up lying about what went wrong.
 */
function failureFor(code: number, description: string, url: string): string {
  const host = hostOf(url) ?? 'that address';
  switch (description) {
    case 'ERR_NAME_NOT_RESOLVED':
      return `Could not find ${host}.`;
    case 'ERR_CONNECTION_REFUSED':
      return `${host} refused the connection. Is the server running?`;
    case 'ERR_CONNECTION_TIMED_OUT':
      return `${host} did not respond.`;
    case 'ERR_INTERNET_DISCONNECTED':
      return 'No network connection.';
    case 'ERR_CERT_AUTHORITY_INVALID':
    case 'ERR_CERT_COMMON_NAME_INVALID':
    case 'ERR_CERT_DATE_INVALID':
      return `${host} has a certificate Artemis does not trust, so the page was not loaded.`;
    default:
      return `${host} could not be loaded (${description || String(code)}).`;
  }
}
