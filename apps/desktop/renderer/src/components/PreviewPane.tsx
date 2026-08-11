/**
 * The preview pane: a page the agent wrote, rendered.
 * ============================================================================
 *
 *     ╭───────────────────────╮╭─────────────────────────╮
 *     │ artemis › Make a chart││ ◱ sales.html   12 KB  ✕ │
 *     ├───────────────────────┤├─────────────────────────┤
 *     │  TRANSCRIPT           ┊│                         │
 *     │   ▸ Wrote sales.html  ┊│      THE PAGE, AS       │
 *     │       [ Preview ]     ┊│      A BROWSER SEES IT  │
 *     │  COMPOSER · STATUS    ┊│                         │
 *     ╰───────────────────────╯╰─────────────────────────╯
 *
 * ## Why this is not a `Pane`
 *
 * `state/pane.ts` is unambiguous about what a pane is: a conversation, and
 * everything scoped to the session inside it — a directory, a profile it bills,
 * a live run, a transcript. A preview has none of those. Making it a member of
 * that union would mean every consumer of `pane.store` and `pane.transcript`
 * learning to narrow first, spreading a check for "is this actually a
 * conversation" across the store, the palette, the hotkeys and the status line,
 * in order to describe something that is not one.
 *
 * So it is a sibling of the grid rather than a cell in it, and the window owns
 * the one that is open. What the reader gets is what they asked for — the
 * artifact beside the conversation, resizable against it — and the grid keeps
 * its invariant that every cell is a conversation.
 *
 * ## The frame's sandbox is the load-bearing line in this file
 *
 * `sandbox="allow-scripts"` and **nothing else**. An artifact is script — it is
 * the whole reason a preview is not just a link — so `allow-scripts` has to be
 * there. What must never join it is `allow-same-origin`: those two together
 * give the frame the parent's origin *and* the ability to use it, at which
 * point a generated page can read the transcript out of the DOM. Each alone is
 * inert. The pair is the vulnerability, and there is no third token worth
 * adding that would tempt anyone into it.
 *
 * That is the renderer's half of the containment; the other three halves are in
 * `main/preview.ts`, which is where the frame's permissive CSP is set and where
 * that CSP's own limits (no network, no remote script) are written down.
 *
 * ## `key` on the frame
 *
 * Opening a second artifact swaps `preview.url`, and React would otherwise
 * reuse the same `<iframe>` element and navigate it. A navigated frame keeps
 * the old document's scroll position and, more to the point, keeps its script
 * running for the moment it takes to load — so the frame is keyed by URL and a
 * new preview gets a genuinely new frame.
 */

import { type ReactElement } from 'react';
import { PanelRightCloseIcon, SquareArrowOutUpRightIcon } from 'lucide-react';

import { formatBytes } from '../lib/attachments';
import { closePreview, useApp } from '../state/store';
import { IconButton } from './disabled-reason';

export function PreviewPane(): ReactElement | null {
  const preview = useApp((s) => s.preview);
  if (!preview) return null;

  return (
    <section
      aria-label="Preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel/40"
    >
      {/* The caption matches a pane's exactly — same height, same border, same
          type scale — because it sits on the same row as one and a preview that
          drew its own chrome would read as a different application stapled to
          the side. */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-2.5">
        <SquareArrowOutUpRightIcon
          className="size-3 shrink-0 text-ink-faint"
          aria-hidden="true"
        />
        <span title={preview.path} className="min-w-0 flex-1 truncate text-2xs font-medium text-ink">
          {preview.title}
        </span>
        <span className="shrink-0 font-mono text-2xs text-ink-faint">
          {formatBytes(preview.bytes)}
        </span>
        <IconButton
          label="Close the preview"
          size="icon-xs"
          onClick={closePreview}
          className="shrink-0 text-ink-faint"
        >
          <PanelRightCloseIcon />
        </IconButton>
      </div>

      {/*
        White, not `--panel`. A page written to be looked at in a browser
        assumes a browser's default background, and an artifact that never set
        `body { background }` — most of them — would otherwise render its black
        text onto Artemis's near-black panel and appear blank. The frame is a
        window onto somewhere else, and it is honest for it to look like one.
      */}
      <iframe
        key={preview.url}
        src={preview.url}
        title={preview.title}
        sandbox="allow-scripts"
        // `referrerPolicy` and `loading` are belt and braces: there is nothing
        // for the frame to fetch and nothing to refer it, but a future edit that
        // loosens the served CSP should not silently gain either.
        referrerPolicy="no-referrer"
        loading="eager"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </section>
  );
}
