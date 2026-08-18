/**
 * Colouring a file, one line at a time.
 * ============================================================================
 *
 * `FileViewer` deferred this deliberately and said where it would go if it ever
 * arrived: *"behind this same component, and nothing outside this file should
 * need to know."* This is that, lifted one level out so the viewer stays about
 * layout and this stays about grammar — the viewer's two hard-won properties, a
 * non-selectable gutter and no wrapping, are layout facts and must not become
 * this file's problem.
 *
 * ## Line by line, which is not how highlighters want to work
 *
 * The viewer draws one element per line, because that is what keeps line numbers
 * out of a copied selection. A highlighter wants the whole document, because
 * grammar crosses lines — a block comment opened on line 4 is still open on
 * line 9.
 *
 * So the document is highlighted **whole** and the result split back into rows.
 * `highlight.js` emits well-formed HTML whose spans can straddle a newline, so
 * splitting naively would leave a `<span>` opened on one row and closed on
 * another, and the browser would repair it by ending every row's colour early.
 * {@link splitHighlightedLines} reopens the still-open spans at the start of the
 * next row, which is what makes a block comment stay one colour all the way
 * down.
 *
 * ## Two palettes, one stylesheet
 *
 * The other reason this was deferred: a theme has to answer to both palettes.
 * Rather than shipping two of the library's themes and swapping them, the
 * classes are mapped to the app's own tokens in CSS — so the file's colours are
 * the app's colours, they move together when either palette changes, and there
 * is no second source of truth for what "a string" looks like.
 *
 * ## The language set is not everything
 *
 * A full registration is a megabyte of grammars for a viewer that mostly shows
 * TypeScript. So a subset is registered by hand — the languages this repo and
 * the projects it works on actually contain — and anything else renders as
 * plain text, which is what it did before this file existed. An unknown
 * extension is not a failure, it is the previous behaviour.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of [
  ['bash', bash],
  ['css', css],
  ['diff', diff],
  ['go', go],
  ['ini', ini],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['markdown', markdown],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
] as const) {
  hljs.registerLanguage(name, language);
}

/**
 * Extension → grammar.
 *
 * Read off the filename rather than sniffed from the contents, because a
 * detector that guesses wrong is worse than one that does not guess: a `.json`
 * shown as Python is more confusing than a `.json` shown as plain text. The
 * viewer already knows the path, so there is nothing to detect.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'bash', sh: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'css', less: 'css',
  diff: 'diff', patch: 'diff',
  go: 'go',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini',
  java: 'java', kt: 'java',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  py: 'python', pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sql: 'sql',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  yml: 'yaml', yaml: 'yaml',
};

/** Files whose whole name decides the grammar, extension or not. */
const BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: 'bash',
  makefile: 'bash',
  '.gitignore': 'bash',
  '.env': 'ini',
};

/** The grammar for a path, or `undefined` to leave it as plain text. */
export function languageFor(path: string): string | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (name in BY_FILENAME) return BY_FILENAME[name];
  const dot = name.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile, not an extension: `.env` has
  // no extension, and reading one would ask for a grammar called "env".
  if (dot <= 0) return undefined;
  return BY_EXTENSION[name.slice(dot + 1)];
}

/**
 * Split highlighted HTML into rows, keeping spans that cross a newline.
 *
 * The whole reason this is not `html.split('\n')`. A span opened on one line and
 * closed three lines later would, split naively, leave the browser to repair
 * three broken rows — and its repair is to close the span at the end of each,
 * which turns a block comment into one coloured line followed by plain ones.
 *
 * So the open tags are tracked as the split walks, and each row is prefixed with
 * whatever is still open and suffixed with the matching closers.
 */
export function splitHighlightedLines(html: string): readonly string[] {
  const rows: string[] = [];
  const open: string[] = [];
  let row = '';

  // Matches one tag or one run of text. `highlight.js` emits only `<span>` and
  // `</span>`, so nothing here has to understand attributes on other elements.
  const token = /(<\/?span[^>]*>)|([^<]+)/g;
  let match: RegExpExecArray | null;

  while ((match = token.exec(html)) !== null) {
    const [, tag, text] = match;

    if (tag !== undefined) {
      if (tag.startsWith('</')) open.pop();
      else open.push(tag);
      row += tag;
      continue;
    }

    const parts = (text ?? '').split('\n');
    parts.forEach((part, index) => {
      if (index > 0) {
        // End of a row: close what is open, start the next with it reopened.
        rows.push(row + '</span>'.repeat(open.length));
        row = open.join('');
      }
      row += part;
    });
  }

  rows.push(row + '</span>'.repeat(open.length));
  return rows;
}

/**
 * Highlight a file into one HTML string per line.
 *
 * Returns `null` when there is no grammar for it or the highlighter throws —
 * both meaning "render it as plain text", which is what the viewer did before
 * this existed. A file that cannot be coloured is not a file that cannot be
 * read, and that is the whole failure policy.
 */
export function highlightLines(text: string, path: string): readonly string[] | null {
  const language = languageFor(path);
  if (language === undefined) return null;
  try {
    const { value } = hljs.highlight(text, { language, ignoreIllegals: true });
    return splitHighlightedLines(value);
  } catch {
    return null;
  }
}
