/**
 * The preview: a page the agent wrote, rendered.
 * ============================================================================
 *
 *     ╭───────────────────────╮╭─────────────────────────╮
 *     │ artemis › Make a chart││ ◱ sales.html ✕  ▸ zsh ✕ │  ← DockPane's strip
 *     ├───────────────────────┤├─────────────────────────┤
 *     │  TRANSCRIPT           ┊│                         │
 *     │   ▸ Wrote sales.html  ┊│      THE PAGE, AS       │  ← this file
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
 * ## This file draws the body and nothing else
 *
 * It used to own the caption above it too — the filename, the byte count, the
 * close button. That row is now `DockPane`'s tab strip, because a preview is no
 * longer the only thing that can be in this rail: it shares it with the user's
 * terminals, and two surfaces each drawing their own chrome would have produced
 * two headers stacked on one another. Ownership and lifetime moved with it, to
 * `state/dock.ts`.
 *
 * ## Two kinds, two treatments
 *
 * An HTML page or an SVG goes in a frame. Markdown does not: it arrives as
 * *text* and is rendered here by the same `react-markdown` pipeline the
 * transcript uses.
 *
 * That is not a shortcut, it is the stricter option. Converting markdown to
 * HTML and serving it into the frame would put generated markup inside the one
 * context in this app that permits inline script, to display something that
 * cannot contain a program in the first place. Rendering it in place keeps it
 * out of that context entirely — and `react-markdown` does not render raw HTML
 * (no `rehype-raw` here, exactly as in the transcript), so a `<script>` written
 * into a `.md` file is displayed as text rather than run.
 *
 * The visible consequence is that a markdown file's embedded HTML shows as
 * source. That is the honest trade for not having a second, weaker markdown
 * path, and it matches what the transcript already does with the same input.
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
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useApp } from '../state/store';

export function PreviewPane(): ReactElement | null {
  const preview = useApp((s) => s.preview);
  if (!preview) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {preview.kind === 'frame' ? (
        /*
          White, not `--panel`. A page written to be looked at in a browser
          assumes a browser's default background, and an artifact that never set
          `body { background }` — most of them — would otherwise render its black
          text onto Artemis's near-black panel and appear blank. The frame is a
          window onto somewhere else, and it is honest for it to look like one.
        */
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
      ) : (
        /*
          Markdown, in Artemis's own type rather than a browser's. The opposite
          call from the frame above, and for the opposite reason: this is not a
          window onto somewhere else, it is a document being read *in* the app,
          so it takes the app's background and the same `.md` styling the
          transcript uses. A reader should not have to switch visual gear
          between an answer and the file that answer wrote.
        */
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="md mx-auto max-w-3xl text-ink">
            <Markdown remarkPlugins={[remarkGfm]}>{preview.text}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}
