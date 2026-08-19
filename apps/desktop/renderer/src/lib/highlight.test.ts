/**
 * Colouring a file, one line at a time.
 *
 * Most of these exist for one problem: the viewer draws a row per line, and
 * grammar does not respect lines. A block comment opened on line 4 is still
 * open on line 9, so splitting highlighted HTML naively leaves a `<span>` opened
 * on one row and closed on another — which the browser repairs by ending the
 * colour early, turning a block comment into one coloured line above several
 * plain ones.
 */

import { describe, expect, it } from 'vitest';

import { highlightLines, languageFor, splitHighlightedLines } from './highlight';

describe('languageFor', () => {
  it.each([
    ['src/store.ts', 'typescript'],
    ['App.tsx', 'typescript'],
    ['script.mjs', 'javascript'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['main.py', 'python'],
    ['index.html', 'xml'],
    ['config.yml', 'yaml'],
    ['run.sh', 'bash'],
    ['Cargo.toml', 'ini'],
  ])('reads %s as %s', (path, expected) => {
    expect(languageFor(path)).toBe(expected);
  });

  it('reads a whole filename when there is no extension', () => {
    expect(languageFor('Dockerfile')).toBe('bash');
    expect(languageFor('project/Makefile')).toBe('bash');
  });

  it('DOTFILE: treats a leading dot as the name, not an extension', () => {
    // `.env` has no extension. Reading one would ask for a grammar called "env".
    expect(languageFor('.env')).toBe('ini');
    expect(languageFor('.gitignore')).toBe('bash');
  });

  it('is case-insensitive, because filesystems are inconsistent about it', () => {
    expect(languageFor('README.MD')).toBe('markdown');
    expect(languageFor('DOCKERFILE')).toBe('bash');
  });

  it('handles a windows path separator', () => {
    expect(languageFor('src\\lib\\store.ts')).toBe('typescript');
  });

  it('returns nothing for a grammar it does not ship', () => {
    // Not a failure — the viewer renders plain text, which is what it always did.
    expect(languageFor('archive.tar.gz')).toBeUndefined();
    expect(languageFor('notes')).toBeUndefined();
  });
});

describe('splitHighlightedLines', () => {
  it('splits plain text into rows', () => {
    expect(splitHighlightedLines('one\ntwo\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('leaves a span that stays on one line alone', () => {
    const rows = splitHighlightedLines('<span class="hljs-keyword">const</span> x\nnext');

    expect(rows[0]).toBe('<span class="hljs-keyword">const</span> x');
    expect(rows[1]).toBe('next');
  });

  it('CROSSING: reopens a span that spans a newline, so both rows are coloured', () => {
    // The whole reason this function exists. Split naively, row two would carry
    // a stray `</span>` and lose its colour.
    const rows = splitHighlightedLines('<span class="hljs-comment">/* one\ntwo */</span> after');

    expect(rows[0]).toBe('<span class="hljs-comment">/* one</span>');
    expect(rows[1]).toBe('<span class="hljs-comment">two */</span> after');
  });

  it('reopens through several lines, not just the next one', () => {
    const rows = splitHighlightedLines('<span class="hljs-comment">a\nb\nc</span>');

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.startsWith('<span class="hljs-comment">')).toBe(true);
      expect(row.endsWith('</span>')).toBe(true);
    }
  });

  it('reopens nested spans in the right order', () => {
    const rows = splitHighlightedLines(
      '<span class="hljs-string">"a<span class="hljs-subst">b\nc</span>d"</span>',
    );

    // Both are still open at the break, so both are reopened, outermost first.
    expect(rows[1]?.startsWith('<span class="hljs-string"><span class="hljs-subst">')).toBe(true);
  });

  it('BALANCE: every row closes exactly what it opens', () => {
    // A row the browser has to repair is a row that loses its colour.
    const rows = splitHighlightedLines(
      '<span class="hljs-comment">x\n<span class="hljs-doctag">y</span>\nz</span>',
    );

    for (const row of rows) {
      const opens = (row.match(/<span/g) ?? []).length;
      const closes = (row.match(/<\/span>/g) ?? []).length;
      expect(closes).toBe(opens);
    }
  });

  it('keeps an empty line as an empty row rather than dropping it', () => {
    // Dropping one would shift every line number after it.
    expect(splitHighlightedLines('a\n\nb')).toEqual(['a', '', 'b']);
  });

  it('returns one row for text with no newline', () => {
    expect(splitHighlightedLines('single')).toEqual(['single']);
  });
});

describe('highlightLines', () => {
  it('returns one row per source line', () => {
    const source = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const rows = highlightLines(source, 'x.ts');

    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(3);
  });

  it('actually colours something', () => {
    const rows = highlightLines('const a = 1;', 'x.ts');

    expect(rows?.[0]).toContain('hljs-');
  });

  it('ESCAPES the source, so a file cannot inject markup', () => {
    // The viewer sets this as innerHTML, so anything unescaped here would be a
    // file that runs when you look at it.
    const rows = highlightLines('const evil = "<img src=x onerror=alert(1)>";', 'x.ts');

    expect(rows?.[0]).not.toContain('<img');
    expect(rows?.[0]).toContain('&lt;img');
  });

  it('keeps a block comment coloured on every line it covers', () => {
    const rows = highlightLines('/* one\n   two\n   three */\nconst a = 1;', 'x.ts');

    expect(rows?.[0]).toContain('hljs-comment');
    expect(rows?.[1]).toContain('hljs-comment');
    expect(rows?.[2]).toContain('hljs-comment');
  });

  it('PLAIN TEXT: returns null for a path it has no grammar for', () => {
    // Which is the previous behaviour, not a failure.
    expect(highlightLines('anything at all', 'notes.unknownext')).toBeNull();
  });

  it('survives source that is not valid in the language it was told', () => {
    // A `.ts` file mid-edit is routinely unparseable, and the viewer must still
    // show it.
    expect(highlightLines('const ((( unclosed', 'x.ts')).not.toBeNull();
  });

  it('handles an empty file', () => {
    expect(highlightLines('', 'x.ts')).toEqual(['']);
  });
});
