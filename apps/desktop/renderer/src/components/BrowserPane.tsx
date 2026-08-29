/**
 * The chrome around a page that this process cannot see.
 * ============================================================================
 *
 *     ╭─────────────────────────────────────────────╮
 *     │ ◱ sales.html ✕ │ ▸ zsh ✕ │ ⊕ example.com ✕  │  ← DockPane's strip
 *     ├─────────────────────────────────────────────┤
 *     │ ‹ › ⟳ │ https://example.com/docs            │  ← this file
 *     ├─────────────────────────────────────────────┤
 *     │                                             │
 *     │        (nothing — the page is drawn         │  ← the hole
 *     │         *behind* this rectangle by main)    │
 *     ╰─────────────────────────────────────────────╯
 *
 * This component draws an address bar, four buttons, and **a hole**. The page
 * itself is a `WebContentsView` that the main process stacks on the window; it
 * is not in this document, not in an iframe, and not reachable from here. What
 * this file does is measure where the hole is and tell main to put the page
 * there — see `protocol/browser.ts` for why that is the arrangement, and why
 * the alternative that would keep layout in CSS cannot show most of the web.
 *
 * ## Everything below follows from the page being a sibling, not a child
 *
 * **The placeholder must have no background.** Painting one would paint *over*
 * nothing — the native view is composited above this element — but the moment
 * the page is hidden or has not loaded, the reader sees whatever is behind it.
 * So the hole is transparent and the surrounding pane supplies the colour.
 *
 * **Layout is an effect, not a render.** The rectangle goes to main over IPC,
 * so it is deliberately kept out of React state: nothing here re-renders when
 * the pane resizes, and a drag does not re-render the transcript beside it.
 *
 * **Anything that overlaps the dock must hide the page.** A native view draws
 * above the document, so a modal, a command palette or a dropdown that reaches
 * across this rectangle would be drawn *under* the page. {@link useBrowserLayout}
 * takes `visible` from the caller for exactly this reason, and `DockPane` is
 * where the answer is assembled.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';

import type { BrowserId } from '@rx-artemis/protocol';

import { commandBrowser, layoutBrowser, navigateBrowser, useApp } from '../state/store';
import { cn } from '../lib/utils';
import { DockHeader } from './DockHeader';
import { Button } from './ui/button';

/**
 * Keep main told where the page goes, for as long as this is mounted.
 *
 * Three things move a browser view and only one of them is a React render, so
 * this listens for all three: the window resizing, the pane resizing (the dock
 * has a drag handle), and the tab changing. `ResizeObserver` covers the first
 * two — it fires for any reason the element's box changes, including a sidebar
 * collapsing beside it — and `visible` covers the third.
 *
 * The last rectangle is remembered so that a visibility change does not have to
 * wait for a measurement: showing a tab sends the bounds it had when it was
 * hidden, which are still correct, rather than a frame of nothing.
 */
function useBrowserLayout(id: BrowserId, visible: boolean): (node: HTMLDivElement | null) => void {
  const element = useRef<HTMLDivElement | null>(null);
  const shown = useRef(visible);
  shown.current = visible;

  const send = useCallback(() => {
    const node = element.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    /*
     * `getBoundingClientRect` is relative to the viewport, which is exactly the
     * window's content area — the renderer fills it, and there is no scrolling
     * chrome outside it. So these coordinates need no translation before main
     * hands them to `setBounds`, and introducing one would be a second place
     * for the two to disagree about where the top of the window is.
     */
    layoutBrowser(
      id,
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      shown.current,
    );
  }, [id]);

  // A ref callback rather than an effect on a ref, so the first measurement
  // happens as soon as the element exists rather than a commit later — the
  // difference is one frame in which the page is at the wrong size.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      element.current = node;
      if (node !== null) send();
    },
    [send],
  );

  useEffect(() => {
    const node = element.current;
    if (node === null) return;

    const observer = new ResizeObserver(send);
    observer.observe(node);
    // The element's own box does not change when the *window* moves, and a
    // window moved to another display can change its scale factor.
    window.addEventListener('resize', send);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', send);
    };
  }, [send]);

  // Visibility is its own effect: it changes without the box changing at all,
  // which is precisely what a tab switch is.
  useEffect(() => {
    send();
  }, [send, visible]);

  /*
   * Detach on unmount. Without this, closing the *pane* while a browser tab is
   * open would leave a native view painted over an empty column — the record
   * survives (a browser outlives its conversation leaving the screen) but there
   * is no longer a rectangle to describe, and the last one main heard is still
   * the last one it believes.
   */
  useEffect(
    () => () => {
      layoutBrowser(id, { x: 0, y: 0, width: 0, height: 0 }, false);
    },
    [id],
  );

  return attach;
}

/**
 * The address bar.
 *
 * Uncontrolled while focused and controlled otherwise, which is the only way to
 * make both halves work: a page that redirects has to update the box, and a
 * user halfway through typing must not have their text replaced by a redirect
 * that happened underneath them. `editing` is that distinction.
 */
function AddressBar({ id, url, loading }: {
  readonly id: BrowserId;
  readonly url: string;
  readonly loading: boolean;
}): ReactElement {
  const [draft, setDraft] = useState(url);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(url);
  }, [url, editing]);

  return (
    <form
      className="flex min-w-0 flex-1 items-center"
      onSubmit={(event) => {
        event.preventDefault();
        setEditing(false);
        void navigateBrowser(id, draft);
      }}
    >
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setEditing(true);
          // Selecting on focus is what every browser does, and it is what makes
          // the box usable at all: the common action is replacing the address,
          // not appending to it.
          event.target.select();
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          // Abandon the edit and go back to where the page actually is, rather
          // than leaving a half-typed address in a box that describes reality.
          setDraft(url);
          setEditing(false);
          event.currentTarget.blur();
        }}
        placeholder="Enter an address"
        spellCheck={false}
        autoComplete="off"
        aria-label="Address"
        className={cn(
          // The mockup's `.bchrome .url` (docs/design/7d-full.html): a wash on
          // the stronger hairline, rounded, in mono. It used to be `bg-inset`
          // — before that `bg-surface`, a token that has never existed, so the
          // class generated nothing and the field had no fill at all. 7D's
          // washes replace the grey steps `--inset` was one of, and the ring
          // that reads as an input is `--hairline-strong` rather than an
          // absence of edge.
          //
          // Mono, because what goes in here is an address: a machine string,
          // and the one place in this row where `l` and `1` have to differ.
          'min-w-0 flex-1 rounded-md border border-hairline-strong bg-wash px-2 py-1 font-mono text-xs text-ink outline-none',
          'placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/50',
          loading && 'text-ink-muted',
        )}
      />
    </form>
  );
}

/** One of the four controls beside the address. */
function NavButton({ label, onClick, disabled, children }: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      // `.bchrome .bi` from docs/design/7d-full.html: a rounded square that is
      // nothing until the pointer is on it, and then a wash. The `ghost`
      // variant's own hover is `--muted`, a grey step from the palette 7D
      // replaced, so it is overridden here rather than left to disagree with
      // the tab strip two centimetres to the left.
      className="size-6 shrink-0 rounded-md hover:bg-wash"
      aria-label={label}
      title={label}
      disabled={disabled === true}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * One browser: its chrome, and the hole its page is drawn in.
 *
 * `visible` is supplied rather than derived because this component cannot know
 * the answer — whether the page should be on screen depends on the active tab,
 * on whether a modal is open, and on whether the window is showing this pane at
 * all. See the file header.
 */
export function BrowserPane({ id, visible }: {
  readonly id: BrowserId;
  readonly visible: boolean;
}): ReactElement | null {
  const record = useApp((s) => s.browsers.find((browser) => browser.info.id === id));
  const attach = useBrowserLayout(id, visible);

  if (record === undefined) return null;
  const { url, loading, canGoBack, canGoForward, failure } = record.info.state;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DockHeader inset="controls" className="gap-1">
        <NavButton
          label="Back"
          disabled={!canGoBack}
          onClick={() => commandBrowser(id, 'back')}
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        </NavButton>
        <NavButton
          label="Forward"
          disabled={!canGoForward}
          onClick={() => commandBrowser(id, 'forward')}
        >
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        </NavButton>
        {/*
          One button that is reload or stop depending on what the page is doing,
          which is what every browser does and what keeps the row from growing a
          control that is disabled nine tenths of the time.
        */}
        <NavButton
          label={loading ? 'Stop' : 'Reload'}
          onClick={() => commandBrowser(id, loading ? 'stop' : 'reload')}
        >
          {loading ? (
            <XIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <RotateCwIcon className="size-3.5" aria-hidden="true" />
          )}
        </NavButton>
        <AddressBar id={id} url={url} loading={loading} />
      </DockHeader>

      {failure === undefined ? null : (
        <div
          role="status"
          // `--amber`, not Tailwind's `amber-500`. This was the only place in
          // the renderer reaching past the design system into the framework
          // palette, which meant one warning in the app was a different yellow
          // from every other warning — and a colour nothing checks for gamut or
          // contrast, since the palette test only knows about ours.
          className="flex shrink-0 items-start gap-1.5 border-b border-hairline bg-amber/10 px-2.5 py-1.5 text-xs text-ink"
        >
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-amber" aria-hidden="true" />
          <span className="min-w-0">{failure}</span>
        </div>
      )}

      {/*
        The hole. No background, no border, no children — the page is composited
        over this rectangle by the main process, and anything drawn here would
        only ever be visible in the moments the page is not.
      */}
      <div ref={attach} className="min-h-0 min-w-0 flex-1" />
    </div>
  );
}
