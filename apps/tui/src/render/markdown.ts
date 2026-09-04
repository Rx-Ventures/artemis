/**
 * Markdown, for a terminal.
 *
 * The assistant writes markdown; a terminal draws characters. This is the
 * smallest translation that reads well: headings bold, emphasis as the
 * terminal's own bold and italic, code in a colour, fenced blocks set off with
 * a gutter, bullets normalised to one glyph, links as text with the address
 * dimmed beside it. It is not a markdown parser and does not try to be one —
 * tables come through as their source, nested structures keep their
 * indentation and nothing more.
 *
 * Why hand-rolled: the desktop's `Markdown.tsx` is `react-markdown` over a DOM,
 * and the terminal libraries that render markdown pull in a highlighter and a
 * parser to do what forty lines of regex do adequately for a transcript.
 *
 * Streaming is the constraint that shapes the code. Text arrives a token at a
 * time and is re-rendered whole on every frame, so this must be cheap, must
 * never throw on a half-written construct — an unclosed fence, a `**` with no
 * partner — and must produce output that does not jump around as the closing
 * marker arrives. Line-based processing with inline rules that leave an
 * unmatched marker alone gives all three.
 */

import {
  BOLD,
  BOLD_OFF,
  CYAN,
  DIM,
  FG_OFF,
  ITALIC,
  ITALIC_OFF,
  RESET,
  UNDERLINE,
  UNDERLINE_OFF,
} from './ansi.js';

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Inline emphasis. Code spans are split out first and the rest never looks
 * inside them — a `**` inside backticks is a literal.
 */
function inline(text: string): string {
  const parts = text.split(/(`+[^`]*`+)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const code = part.replace(/^`+|`+$/g, '');
        return `${CYAN}${code}${FG_OFF}`;
      }
      return part
        .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/__(.+?)__/g, `${BOLD}$1${BOLD_OFF}`)
        .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
        .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, `$1${ITALIC}$2${ITALIC_OFF}`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, `${UNDERLINE}$1${UNDERLINE_OFF} ${DIM}$2${RESET}`);
    })
    .join('');
}

export function renderMarkdown(source: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const raw of source.split('\n')) {
    const line = raw.replace(/\r$/, '');

    if (fence !== null) {
      if (FENCE.test(line) && line.trim().startsWith(fence)) {
        fence = null;
        continue;
      }
      out.push(`${DIM}│${RESET} ${line}`);
      continue;
    }

    const open = FENCE.exec(line);
    if (open !== null) {
      fence = open[1] ?? '```';
      const lang = open[2] ?? '';
      out.push(`${DIM}│${lang.length > 0 ? ` ${lang}` : ''}${RESET}`);
      continue;
    }

    if (RULE.test(line)) {
      out.push(`${DIM}${'─'.repeat(24)}${RESET}`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const text = inline(heading[2] ?? '');
      out.push(
        (heading[1]?.length ?? 2) === 1
          ? `${BOLD}${UNDERLINE}${text}${UNDERLINE_OFF}${BOLD_OFF}`
          : `${BOLD}${text}${BOLD_OFF}`,
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ''}${DIM}•${RESET} ${inline(bullet[2] ?? '')}`);
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      out.push(`${ordered[1] ?? ''}${DIM}${ordered[2]}.${RESET} ${inline(ordered[3] ?? '')}`);
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      out.push(`${DIM}▎ ${inline(quote[1] ?? '')}${RESET}`);
      continue;
    }

    out.push(inline(line));
  }

  return out.join('\n');
}
