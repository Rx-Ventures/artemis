/**
 * Choosing where to work.
 *
 * Reported as: typing a path into `/cwd` is the wrong way to move. The right
 * way is the desktop's — pick a folder already worked in, or browse for one.
 * These pin what those two lists contain and in what order.
 */

import { describe, expect, it } from 'vitest';

import { browseRowLabel, browseRows, recentDirectories, shortenPath } from './directories.js';

type Entry = { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean };
const dirent = (name: string, directory = true): Entry => ({
  name,
  isDirectory: () => directory,
  isSymbolicLink: () => false,
});
const link = (name: string): Entry => ({ name, isDirectory: () => false, isSymbolicLink: () => true });

describe('recentDirectories', () => {
  const sessions = [
    { cwd: '/w/api', updatedAt: 300 },
    { cwd: '/w/web', updatedAt: 100 },
    { cwd: '/w/api', updatedAt: 500 },
  ];

  it('lists folders once, newest first, counting what is in them', () => {
    const recents = recentDirectories(sessions, '/w/api', '/home/ada');

    // `api` holds two conversations and is dated by the newer of them.
    expect(recents).toEqual([
      { path: '/w/api', label: '/w/api', updatedAt: 500, count: 2 },
      { path: '/w/web', label: '/w/web', updatedAt: 100, count: 1 },
    ]);
  });

  it('offers the current folder even when nothing has run there', () => {
    const recents = recentDirectories(sessions, '/w/fresh', '/home/ada');

    // It is where Enter would start a conversation, so it has to be
    // offerable; a chooser that cannot offer "here" cannot express staying.
    expect(recents[0]).toMatchObject({ path: '/w/fresh', count: 0 });
    expect(recents.map((recent) => recent.path)).toEqual(['/w/fresh', '/w/api', '/w/web']);
  });

  it('writes a path the way a person would', () => {
    expect(recentDirectories([{ cwd: '/home/ada/code/x', updatedAt: 1 }], '/home/ada', '/home/ada')).toEqual([
      { path: '/home/ada', label: '~', updatedAt: Number.MAX_SAFE_INTEGER, count: 0 },
      { path: '/home/ada/code/x', label: '~/code/x', updatedAt: 1, count: 1 },
    ]);
  });
});

describe('shortenPath', () => {
  it('shortens only a real prefix of home', () => {
    expect(shortenPath('/home/ada', '/home/ada')).toBe('~');
    expect(shortenPath('/home/ada/x', '/home/ada')).toBe('~/x');
    // `/home/adamant` is not inside `/home/ada`, however it reads.
    expect(shortenPath('/home/adamant/x', '/home/ada')).toBe('/home/adamant/x');
  });
});

describe('browseRows', () => {
  it('offers where you are first, then up, then the folders in name order', () => {
    const rows = browseRows('/w/api', [dirent('src'), dirent('Docs'), dirent('lib')]);

    // Choosing is the first row so that accepting a folder is Enter, with no
    // second key to learn.
    expect(rows).toEqual([
      { kind: 'choose', path: '/w/api' },
      { kind: 'up', path: '/w' },
      { kind: 'down', path: '/w/api/Docs', name: 'Docs' },
      { kind: 'down', path: '/w/api/lib', name: 'lib' },
      { kind: 'down', path: '/w/api/src', name: 'src' },
    ]);
  });

  it('shows a symlinked folder, which is most of what some directories hold', () => {
    // `isDirectory()` is false for every entry in a pnpm `node_modules`, and
    // dropping them made those folders invisible beside their siblings.
    const rows = browseRows('/w/api/node_modules', [link('react'), dirent('@types')]);

    expect(rows.map((row) => row.path)).toEqual([
      '/w/api/node_modules',
      '/w/api',
      '/w/api/node_modules/@types',
      '/w/api/node_modules/react',
    ]);
  });

  it('leaves out files and hidden folders, and has no way up from the root', () => {
    const rows = browseRows('/', [dirent('etc'), dirent('.git'), dirent('README.md', false)]);

    expect(rows).toEqual([
      { kind: 'choose', path: '/' },
      { kind: 'down', path: '/etc', name: 'etc' },
    ]);
  });

  it('labels the rows as they read on screen', () => {
    const rows = browseRows('/home/ada/code', [dirent('artemis')]);

    // The `..` row names where it goes — the parent — not where you are.
    expect(rows.map((row) => browseRowLabel(row, '/home/ada'))).toEqual(['use this folder', '..  ~', 'artemis/']);
  });
});
