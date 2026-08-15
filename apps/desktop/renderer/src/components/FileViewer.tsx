/**
 * A file, as text, beside the conversation that mentioned it.
 * ============================================================================
 *
 *     ╭───────────────────────╮╭──────────────────────────╮
 *     │ artemis › Wire seam   ││ ◱ page.html ✕ │ ▤ files.ts ✕ │
 *     ├───────────────────────┤├──────────────────────────┤
 *     │  TRANSCRIPT           ┊│  1  import { open } from │
 *     │   I read `files.ts`   ┊│  2                       │
 *     │            ^^^^^^^^   ┊│  3  export async function│
 *     │  COMPOSER · STATUS    ┊│                          │
 *     ╰───────────────────────╯╰──────────────────────────╯
 *
 * The other half of {@link PreviewPane}. That one answers "render this the way a
 * browser would" and can do it for five extensions; this answers "show me what
 * is in it" and can do it for anything that holds text — which is to say, for
 * the file the conversation was actually about.
 *
 * ## No syntax highlighting, on purpose and for now
 *
 * The issue this was built for said so outright, and there is a reason worth
 * keeping past the first request: highlighting means shipping a grammar set and
 * choosing a theme that has to answer to both palettes, and neither of those is
 * on the path to "I want to see the file I just read". The type is monospaced,
 * the lines are numbered, and everything else is deferred. If it arrives later
 * it belongs *here*, behind this same component, and nothing outside this file
 * should need to know.
 *
 * ## The line numbers are a column, not a prefix
 *
 * They live in their own `<span>` per row rather than being prepended to the
 * text, which is what keeps them out of a selection. Dragging across a file to
 * copy a function and getting `12  13  14` interleaved through it is the single
 * most irritating thing a numbered view can do, and `user-select: none` on the
 * gutter is the whole fix.
 *
 * That does mean one element per line, so the row count is capped — see
 * {@link MAX_LINES}. A file long enough to hit that cap is long enough that the
 * viewer was the wrong tool, and the caption says what it is showing.
 *
 * ## Following a `:line`
 *
 * A reference like `files.ts:88` scrolls that row into view and marks it. The
 * mark is a background, not a scroll position, because a reader who then scrolls
 * away has no way back to a position — and the thing they were sent to look at
 * is a *line*, which can go on being pointed at.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react';

import { useApp } from '../state/store';
import { formatBytes } from '../lib/attachments';
import { CopyButton } from './primitives';
import { cn } from '@/lib/utils';

/**
 * How many lines are drawn.
 *
 * One DOM node per line is what buys a non-selectable gutter, and 20,000 of them
 * is where that stops being free. `main/files.ts` has already capped the read at
 * 2MB; this caps the *rendering*, which is a different limit for a different
 * reason and can be much lower — nobody reads the 20,000th line of anything in a
 * pane with no search in it.
 */
const MAX_LINES = 20_000;

export function FileViewer(): ReactElement | null {
  const file = useApp((s) => s.file);

  /*
   * Split once per file rather than per render. The dock re-renders on every
   * store write — a keystroke in the composer, a token from the agent — and
   * splitting two megabytes on each of those is the one genuinely expensive
   * thing this component could do.
   */
  const lines = useMemo(() => (file === null ? [] : file.text.split('\n')), [file]);

  if (file === null) return null;

  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
  const clipped = lines.length > MAX_LINES;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Caption
        path={file.path}
        bytes={file.bytes}
        lines={lines.length}
        truncated={file.truncated}
        clipped={clipped}
        text={file.text}
      />
      <Body lines={shown} line={file.line} />
    </div>
  );
}

/**
 * What is on screen, and what is not.
 *
 * The second half is the point. A viewer that silently shows the first 2MB of a
 * 47MB log looks exactly like a viewer showing a 47MB log, and the reader draws
 * conclusions from the end of a file that is not the end of the file.
 */
function Caption({
  path,
  bytes,
  lines,
  truncated,
  clipped,
  text,
}: {
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
  readonly truncated: boolean;
  readonly clipped: boolean;
  readonly text: string;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-faint" title={path}>
        {path}
      </span>
      <span className="shrink-0 font-mono text-2xs text-ink-faint">
        {lines.toLocaleString()} {lines === 1 ? 'line' : 'lines'} · {formatBytes(bytes)}
      </span>
      {truncated || clipped ? (
        <span
          className="shrink-0 rounded-sm border border-amber/40 px-1.5 font-mono text-2xs text-amber"
          title={
            truncated
              ? 'This file is larger than Artemis reads into a view. What is shown is the beginning of it.'
              : 'This file has more lines than the viewer draws. What is shown is the beginning of it.'
          }
        >
          partial
        </span>
      ) : (
        /*
          Only for a whole file. Offering "copy" on a partial one would put a
          truncated version on the clipboard under a button that says nothing
          about it — and the reader has no way to tell from the paste.
        */
        <CopyButton
          text={text}
          label="Copy this file"
          // Always visible: there is no block to hover here, so the hover-reveal
          // the markdown blocks use would leave this one unfindable.
          className="opacity-100"
        />
      )}
    </div>
  );
}

function Body({
  lines,
  line,
}: {
  readonly lines: readonly string[];
  readonly line: number | undefined;
}): ReactElement {
  const marked = useRef<HTMLDivElement>(null);

  /*
   * `block: 'center'` puts the line in the middle rather than at the top edge,
   * which is what makes the context around it readable — being sent to line 88
   * and finding it pinned under the caption tells you nothing about what leads
   * up to it. Runs once: the component is keyed by path in `DockPane`, so a
   * different file is a different instance with its own effect.
   */
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' });
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="min-w-max py-1 font-mono text-2xs leading-relaxed">
        {lines.map((text, index) => {
          const number = index + 1;
          const isMarked = number === line;
          return (
            <div
              key={number}
              ref={isMarked ? marked : undefined}
              className={cn('flex gap-3 px-3', isMarked && 'bg-amber/10')}
            >
              <span
                // `select-none` is the whole reason the gutter is an element:
                // copying a range out of the file must not bring the numbers.
                className={cn(
                  'w-10 shrink-0 text-right tabular-nums select-none',
                  isMarked ? 'text-amber' : 'text-ink-faint/60',
                )}
                aria-hidden="true"
              >
                {number}
              </span>
              {/*
                `whitespace-pre` and no wrapping: this is a file, and a line that
                wraps has silently changed what line 40 means. The pane scrolls
                sideways instead, which is what every editor does and what makes
                the numbers trustworthy.
              */}
              <span className="whitespace-pre text-ink-muted">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
