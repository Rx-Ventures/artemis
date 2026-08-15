/**
 * Which backticked fragments become links.
 *
 * This is the whole judgement behind the file viewer, and the reason it gets a
 * test of its own is that both ways of being wrong are invisible in review: a
 * rule that is too eager turns half of an answer's prose into links and only
 * shows it on a page nobody screenshotted, and a rule that is too shy silently
 * does nothing, which reads as the feature not working.
 *
 * So the cases below are grouped by what they are protecting. The "declines"
 * group is the larger one on purpose — a link that does nothing is a worse
 * experience than a word that was never a link, and the rule is written to lean
 * that way when it is unsure.
 */

import { describe, expect, it } from 'vitest';

import { parseFileReference, resolveFilePath } from './filePaths';

describe('parseFileReference', () => {
  describe('recognises', () => {
    it('a relative path', () => {
      expect(parseFileReference('apps/desktop/main/files.ts')).toEqual({
        path: 'apps/desktop/main/files.ts',
      });
    });

    it('an absolute path', () => {
      expect(parseFileReference('/tmp/report.md')).toEqual({ path: '/tmp/report.md' });
    });

    it('a bare filename, which is how an answer usually names one', () => {
      expect(parseFileReference('README.md')).toEqual({ path: 'README.md' });
    });

    it('a dotfile', () => {
      expect(parseFileReference('.eslintrc.json')).toEqual({ path: '.eslintrc.json' });
    });

    it('a line number, and keeps it', () => {
      expect(parseFileReference('src/store.ts:88')).toEqual({ path: 'src/store.ts', line: 88 });
    });

    it('a line and column, keeping only the line', () => {
      // The viewer marks a row; a column would have nothing to point at.
      expect(parseFileReference('src/store.ts:88:12')).toEqual({ path: 'src/store.ts', line: 88 });
    });

    it('surrounding whitespace, which a code span can carry', () => {
      expect(parseFileReference('  main/files.ts  ')).toEqual({ path: 'main/files.ts' });
    });
  });

  describe('declines', () => {
    it('a bare word', () => {
      expect(parseFileReference('useCopy')).toBeNull();
    });

    it('a command with arguments', () => {
      expect(parseFileReference('pnpm test --watch')).toBeNull();
    });

    it('a flag', () => {
      expect(parseFileReference('--force')).toBeNull();
    });

    it('a call, which looks like a path with a dot in it', () => {
      expect(parseFileReference('files.map()')).toBeNull();
    });

    it('a slashed phrase, which is what an extension test buys over a slash test', () => {
      expect(parseFileReference('and/or')).toBeNull();
      expect(parseFileReference('TypeScript/JavaScript')).toBeNull();
    });

    it('a version number', () => {
      expect(parseFileReference('v1.2.3')).toBeNull();
      expect(parseFileReference('0.12.0')).toBeNull();
    });

    it('a URL', () => {
      expect(parseFileReference('https://example.com/a.ts')).toBeNull();
    });

    it('a directory', () => {
      expect(parseFileReference('apps/desktop/main/')).toBeNull();
      expect(parseFileReference('src/components')).toBeNull();
    });

    it('a home-relative path, which the renderer cannot expand', () => {
      // Better as plain text than as a link that resolves to `<cwd>/~/…`.
      expect(parseFileReference('~/.claude/settings.json')).toBeNull();
    });

    it('a shell pipeline that happens to contain a filename', () => {
      expect(parseFileReference('cat notes.txt | wc -l')).toBeNull();
    });

    it('a quoted path, which is a fragment of code rather than a reference', () => {
      expect(parseFileReference('"./x.ts"')).toBeNull();
    });

    it('nothing at all', () => {
      expect(parseFileReference('')).toBeNull();
      expect(parseFileReference('   ')).toBeNull();
    });

    it('something far too long to be a path anyone wrote', () => {
      expect(parseFileReference(`${'a/'.repeat(400)}x.ts`)).toBeNull();
    });
  });
});

describe('resolveFilePath', () => {
  it('joins a relative path onto the conversation’s directory', () => {
    expect(resolveFilePath('main/files.ts', '/Users/ada/artemis', 'darwin')).toBe(
      '/Users/ada/artemis/main/files.ts',
    );
  });

  it('leaves an absolute path alone', () => {
    expect(resolveFilePath('/tmp/report.md', '/Users/ada/artemis', 'darwin')).toBe(
      '/tmp/report.md',
    );
  });

  it('drops a leading ./', () => {
    expect(resolveFilePath('./main/files.ts', '/Users/ada/artemis', 'darwin')).toBe(
      '/Users/ada/artemis/main/files.ts',
    );
  });

  it('does not double the separator when the directory ends in one', () => {
    expect(resolveFilePath('files.ts', '/Users/ada/artemis/', 'darwin')).toBe(
      '/Users/ada/artemis/files.ts',
    );
  });

  it('uses the platform’s separator, and its idea of absolute', () => {
    expect(resolveFilePath('main\\files.ts', 'C:\\src\\artemis', 'win32')).toBe(
      'C:\\src\\artemis\\main\\files.ts',
    );
    expect(resolveFilePath('C:\\src\\x.ts', 'C:\\src\\artemis', 'win32')).toBe('C:\\src\\x.ts');
  });

  it('leaves `..` for the filesystem to resolve', () => {
    // Deliberately not normalised here: the disk is the authority on what it
    // means, and a second implementation could only disagree with it.
    expect(resolveFilePath('../sibling/x.ts', '/Users/ada/artemis', 'darwin')).toBe(
      '/Users/ada/artemis/../sibling/x.ts',
    );
  });
});
