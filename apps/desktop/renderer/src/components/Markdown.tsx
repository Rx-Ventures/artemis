/**
 * The one markdown pipeline.
 * ============================================================================
 *
 * Three surfaces render markdown — an answer in the transcript, a `.md` file in
 * the preview, a plan in its approval card — and until this file existed all
 * three wrote out `<Markdown remarkPlugins={[remarkGfm]}>` themselves. Identical
 * by coincidence rather than by construction, which is the arrangement where the
 * fourth caller quietly gets a different set of plugins and nobody notices until
 * a table renders as text in one place and a grid in another.
 *
 * So the configuration lives here and the callers say `<Markdown>`. The thing
 * that made it worth doing now is the copy button below: a per-call-site
 * `components` map would have been the same coincidence again, with more of it.
 *
 * ## Still no `rehype-raw`, in any of them
 *
 * The security posture is unchanged and is the reason this wrapper does not take
 * a `rehypePlugins` prop. `react-markdown` does not render raw HTML unless it is
 * asked to, so a `<script>` written into an answer or a `.md` file is displayed
 * as text. `PreviewPane`'s header explains what that buys and what it costs; the
 * point here is that it is now one decision rather than three, and adding a
 * prop to loosen it per caller would put it back to three.
 *
 * ## Why the copy button hangs off `pre`, not `code`
 *
 * `code` is both halves of the language: the fenced block and the backticked
 * word in the middle of a sentence. Only the block gets a `pre` around it, so
 * overriding `pre` is what distinguishes "a snippet someone wants to run
 * somewhere else" from "a symbol named in a paragraph", with no need to inspect
 * a `language-*` class that fenced blocks do not always carry anyway.
 *
 * ## The wrapper div, and why `.md` does not mind it
 *
 * The button is a sibling of the `<pre>` inside a positioned wrapper rather than
 * a child of it. Inside, it would join the block's own text — selecting the
 * snippet would select the button, and copying by hand, which is what people
 * fall back to, would pick up its label. It is also inside `overflow-x: auto`
 * there, so it would slide away from the corner on a long line.
 *
 * The wrapper takes the `<pre>`'s place as a child of `.md`, which matters
 * because that stylesheet's spacing rule is `.md > * + *`. A wrapper is one
 * child in the same position, so the space above a code block is what it was.
 * `.md pre` still styles the `<pre>` itself, since it is a descendant selector.
 *
 * ## The text comes from the hast node
 *
 * `node` is the parsed tree `react-markdown` hands to a component override, and
 * walking it is how the raw source of the block is recovered — the React
 * children at that point are elements, and reassembling a string from them means
 * reaching into rendered output for something the parser already knows exactly.
 * Fenced code arrives as one text node under one `code` element; the walk is
 * recursive anyway because that is a fact about today's parser rather than a
 * guarantee, and a plugin that decorates the block should not silently truncate
 * what gets copied.
 */

import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
} from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { parseFileReference, type FileReference } from '../lib/filePaths';
import { CopyButton } from './primitives';

/**
 * A hast node, named without importing `hast`.
 *
 * `@types/hast` is `react-markdown`'s dependency rather than the desktop app's,
 * so it resolves for that package's own declarations and is not ours to import
 * by name. Deriving the type from the prop it arrives on gets the real thing —
 * including the `text` / `element` discriminant {@link textOf} narrows on —
 * without adding a dependency to say so.
 */
type MarkdownNode = NonNullable<ExtraProps['node']>;

/** Every bit of text under a node, in document order. */
function textOf(node: MarkdownNode | undefined): string {
  if (node === undefined) return '';
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += textOf(child);
  }
  return out;
}

/**
 * A fenced block, with the button that copies it.
 *
 * The trailing newline goes. `mdast-to-hast` terminates a fenced block's text
 * with one, and pasting a stray blank line into a SQL console or a shell is a
 * small nuisance that is entirely this layer's doing. Only the last one, and
 * only at the end: leading indentation is the snippet's, and a deliberate blank
 * line before the close of a fence is rare enough that losing exactly one
 * character of it beats shipping the artefact to everybody.
 */
function CopyablePre({
  node,
  children,
  ...rest
}: ComponentPropsWithoutRef<'pre'> & ExtraProps): ReactElement {
  const text = textOf(node).replace(/\n$/, '');
  return (
    <div className="group/copy relative">
      {/*
        The fence is announced to the `code` below it, which is the same
        component that renders a backticked word mid-sentence and has no other
        way to tell the two apart. Context rather than a parser detail — a fenced
        block's text happens to end in a newline and an inline span's does not,
        which is true today and is not a thing to build on.
      */}
      <pre {...rest}>
        <Fenced.Provider value={true}>{children}</Fenced.Provider>
      </pre>
      <CopyButton text={text} label="Copy this code" className="absolute top-1.5 right-1.5" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File references                                                            */
/* -------------------------------------------------------------------------- */

/** True inside a fenced block. See {@link CopyablePre}. */
const Fenced = createContext(false);

/** How to act on a path the reader clicked, or `null` to render paths as text. */
const OpenFile = createContext<((reference: FileReference) => void) | null>(null);

/**
 * A backticked fragment, which is sometimes a file.
 *
 * Most of them are not — `useCopy`, `--force`, `pnpm test` — so the great
 * majority of what this renders is the plain `<code>` it always was.
 * `parseFileReference` holds the judgement and the argument for where it draws
 * the line.
 *
 * A **button**, not an anchor. There is no URL here and nothing to put in an
 * `href`: the path is resolved against a conversation's directory and read over
 * IPC, so an anchor would be a link that cannot be opened in a new window,
 * copied as a location, or followed by anything but this handler. The `<code>`
 * stays inside it, which keeps `.md code`'s well and lets the button supply only
 * what it adds — a colour, an underline, and a focus ring.
 */
function CodeSpan({
  node,
  children,
  ...rest
}: ComponentPropsWithoutRef<'code'> & ExtraProps): ReactElement {
  const fenced = useContext(Fenced);
  const open = useContext(OpenFile);
  const reference = fenced || open === null ? null : parseFileReference(textOf(node));

  if (reference === null || open === null) return <code {...rest}>{children}</code>;

  return (
    <button
      type="button"
      onClick={() => open(reference)}
      title={reference.line === undefined ? reference.path : `${reference.path}, line ${String(reference.line)}`}
      className="cursor-pointer rounded-sm text-lunar underline decoration-lunar/40 underline-offset-2 outline-none hover:decoration-lunar focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <code {...rest}>{children}</code>
    </button>
  );
}

const COMPONENTS: Components = { pre: CopyablePre, code: CodeSpan };
const REMARK_PLUGINS = [remarkGfm];

export interface MarkdownProps {
  readonly children: string;
  /**
   * What to do when the reader clicks a path.
   *
   * Absent — the default, and what the preview pane and the plan card both
   * use — means paths render as ordinary code. Passing it is what turns them
   * into links, and the caller supplies it rather than this component reaching
   * for the store because the *conversation* is what a relative path resolves
   * against, and only the caller knows which one it is drawing.
   */
  readonly onOpenFile?: (reference: FileReference) => void;
}

/**
 * Markdown, the way Artemis renders it.
 *
 * Memoised on its props. The transcript re-renders a settled answer whenever
 * anything else in the pane moves, and re-parsing a long answer to produce the
 * identical tree is the most expensive thing on that path — so a caller passing
 * `onOpenFile` should pass a stable one, which `AssistantRow` does.
 */
export const Markdown = memo(function Markdown({
  children,
  onOpenFile,
}: MarkdownProps): ReactElement {
  /*
   * One context for the whole block rather than a hook in every span. A long
   * answer holds a hundred `<code>` elements, and this is the difference between
   * one subscription and a hundred of them.
   */
  const open = useMemo(() => onOpenFile ?? null, [onOpenFile]);

  return (
    <OpenFile.Provider value={open}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </OpenFile.Provider>
  );
});
