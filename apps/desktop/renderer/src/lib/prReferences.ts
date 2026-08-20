/**
 * Bare pull-request references, turned into the links they were withholding.
 *
 * An agent that opens a PR usually pastes the URL, and `PullRequestLink` gives
 * that anchor its hover reading. But prose — the agent's and the user's alike —
 * says `#141`, or `Rx-Ventures/artemis#141`, or "see PR #98", and those were
 * dead text: the one spelling humans actually use was the one spelling that
 * went nowhere.
 *
 * This remark plugin rewrites those references into ordinary links during the
 * parse, which is the whole trick: downstream nothing changes. The anchor it
 * emits is rendered by the same `a:` component as a pasted URL, so a bare
 * `#141` gets the same state-dot, checks and size reading on hover that the
 * full URL always had — one feature, reached from both spellings.
 *
 * ## Where the repository comes from
 *
 * `owner/repo#123` names its repository and needs nothing. A bare `#123` is
 * only meaningful *somewhere*, and the somewhere is the pane's working
 * directory: `WorkspaceNames.github` carries the `origin` remote's coordinates
 * when that remote points at GitHub. No remote, or a remote on another host,
 * and bare references stay text — a link invented for the wrong repository
 * would be worse than the dead text this replaces.
 *
 * ## Deliberate misses
 *
 * Code spans and fenced blocks are never touched (`#123` in a diff hunk or a
 * shell comment is code), existing links are never re-linked, and the number
 * must be delimited the way prose delimits it — `#123abc` and `abc#123` stay
 * text. The URL is the `/pull/` form; GitHub redirects it when the number
 * turns out to be an issue, and the hover degrades to "no pull request there"
 * while the link keeps working — the same failure direction every link in
 * `PullRequestLink` is built around.
 */

import type { PullRequestRef } from '@rx-artemis/protocol';

/** The coordinates a bare reference resolves against. */
export interface RepositoryCoordinates {
  readonly owner: string;
  readonly repo: string;
}

/**
 * One reference in prose: optional `owner/repo`, a `#`, digits — delimited on
 * both sides the way a sentence delimits a word. The boundary classes are
 * spelled out rather than `\b` because `#` is not a word character: `\b#123`
 * would happily match inside `abc#123`.
 */
const REFERENCE =
  /(^|[\s([{])((?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d{1,10}))(?=$|[\s.,;:!?)\]}])/g;

interface TextNode {
  type: 'text';
  value: string;
}

interface ParentNode {
  type: string;
  children: Array<TextNode | ParentNode | LinkNode>;
}

interface LinkNode {
  type: 'link';
  url: string;
  children: TextNode[];
}

/** Containers whose text must never become links. */
const OPAQUE = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'html']);

function isParent(node: unknown): node is ParentNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

/** Split one text node around its references. `null` when it holds none. */
function splitText(
  node: TextNode,
  fallback: RepositoryCoordinates | null,
): Array<TextNode | LinkNode> | null {
  const out: Array<TextNode | LinkNode> = [];
  let consumed = 0;
  let linked = false;

  REFERENCE.lastIndex = 0;
  for (let match = REFERENCE.exec(node.value); match !== null; match = REFERENCE.exec(node.value)) {
    const [, lead = '', reference = '', owner, repo, digits = ''] = match;
    const at = match.index + lead.length;

    const target =
      owner !== undefined && repo !== undefined ? { owner, repo } : fallback;
    // A bare reference with no repository to resolve against stays text —
    // skipping the match rather than aborting, because `owner/repo#n` later in
    // the same sentence still deserves its link.
    if (target === null) continue;

    if (at > consumed) out.push({ type: 'text', value: node.value.slice(consumed, at) });
    out.push({
      type: 'link',
      url: `https://github.com/${target.owner}/${target.repo}/pull/${digits}`,
      children: [{ type: 'text', value: reference }],
    });
    consumed = at + reference.length;
    linked = true;
  }

  if (!linked) return null;
  if (consumed < node.value.length) {
    out.push({ type: 'text', value: node.value.slice(consumed) });
  }
  return out;
}

function walk(node: ParentNode, fallback: RepositoryCoordinates | null): void {
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child === undefined || OPAQUE.has(child.type)) continue;

    if (child.type === 'text') {
      const replacement = splitText(child as TextNode, fallback);
      if (replacement !== null) {
        node.children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
      continue;
    }

    if (isParent(child)) walk(child, fallback);
  }
}

/**
 * The plugin, as a factory: remark calls the returned transformer per parse.
 *
 * A factory rather than a bare plugin because the fallback repository is an
 * argument — the caller builds one plugin array per repository and memoises
 * it, which is what keeps this off the transcript's re-render path.
 */
export function remarkPullRequestReferences(fallback: RepositoryCoordinates | null) {
  return () =>
    (tree: unknown): void => {
      if (isParent(tree)) walk(tree, fallback);
    };
}

/** Re-exported so callers can speak the protocol's name for a resolved ref. */
export type { PullRequestRef };
