import { describe, expect, it } from 'vitest';

import { bundledSdkExecutablePath, sdkExecutableNames, sdkPackageNames } from './sdkBinary';

const RESOURCES = '/opt/Artemis/resources';

const unpacked = (packageName: string): string =>
  `${RESOURCES}/app.asar.unpacked/node_modules/@anthropic-ai/${packageName}`;

/** A `readdir` over a fixed layout: any directory not listed does not exist. */
const layout =
  (tree: Readonly<Record<string, readonly string[]>>) =>
  (path: string): readonly string[] => {
    const entries = tree[path];
    if (entries === undefined) {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
      error.code = 'ENOENT';
      throw error;
    }
    return entries;
  };

describe('sdkPackageNames', () => {
  /*
   * Linux is the one platform where "platform and arch" does not name a single
   * binary: the SDK publishes a musl variant per architecture, and on an Alpine
   * base image that is the only one pnpm installs.
   */
  it('offers the musl variant on Linux, and only there', () => {
    expect(sdkPackageNames('linux', 'x64')).toEqual([
      'claude-agent-sdk-linux-x64',
      'claude-agent-sdk-linux-x64-musl',
    ]);
    expect(sdkPackageNames('darwin', 'arm64')).toEqual(['claude-agent-sdk-darwin-arm64']);
    expect(sdkPackageNames('win32', 'x64')).toEqual(['claude-agent-sdk-win32-x64']);
  });

  it('puts the exact name first, since that is what a glibc host installed', () => {
    expect(sdkPackageNames('linux', 'arm64')[0]).toBe('claude-agent-sdk-linux-arm64');
  });
});

describe('sdkExecutableNames', () => {
  it('knows which name the binary has', () => {
    expect(sdkExecutableNames('win32')).toEqual(['claude.exe']);
    expect(sdkExecutableNames('linux')).toEqual(['claude']);
    expect(sdkExecutableNames('darwin')).toEqual(['claude']);
  });
});

describe('bundledSdkExecutablePath', () => {
  it('finds the glibc package on an ordinary Linux host', () => {
    const readdir = layout({ [unpacked('claude-agent-sdk-linux-x64')]: ['claude', 'README.md'] });
    expect(bundledSdkExecutablePath(RESOURCES, 'linux', 'x64', readdir)).toBe(
      `${unpacked('claude-agent-sdk-linux-x64')}/claude`,
    );
  });

  /*
   * The bug. A musl host installs only the `-musl` package, so a lookup for the
   * exact name found nothing, the engine started with no executable path, and
   * the SDK fell back to resolving relative to itself — inside the asar, where
   * spawn fails with ENOTDIR and blames a path component instead of the C
   * library. verify-package.ts has accepted either name since it was written.
   */
  it('finds the musl package when that is the only one installed', () => {
    const readdir = layout({ [unpacked('claude-agent-sdk-linux-x64-musl')]: ['claude'] });
    expect(bundledSdkExecutablePath(RESOURCES, 'linux', 'x64', readdir)).toBe(
      `${unpacked('claude-agent-sdk-linux-x64-musl')}/claude`,
    );
  });

  it('prefers glibc when a tree somehow holds both', () => {
    const readdir = layout({
      [unpacked('claude-agent-sdk-linux-x64')]: ['claude'],
      [unpacked('claude-agent-sdk-linux-x64-musl')]: ['claude'],
    });
    expect(bundledSdkExecutablePath(RESOURCES, 'linux', 'x64', readdir)).toBe(
      `${unpacked('claude-agent-sdk-linux-x64')}/claude`,
    );
  });

  it('finds claude.exe on Windows', () => {
    const readdir = layout({ [unpacked('claude-agent-sdk-win32-x64')]: ['claude.exe'] });
    expect(bundledSdkExecutablePath(RESOURCES, 'win32', 'x64', readdir)).toBe(
      `${unpacked('claude-agent-sdk-win32-x64')}/claude.exe`,
    );
  });

  /*
   * Undefined rather than a guess, in both cases: the SDK then fails with its
   * own message, which names the real problem.
   */
  it('gives up rather than guessing when no package ships a binary', () => {
    const empty = layout({ [unpacked('claude-agent-sdk-linux-x64')]: ['README.md'] });
    expect(bundledSdkExecutablePath(RESOURCES, 'linux', 'x64', empty)).toBeUndefined();
    expect(bundledSdkExecutablePath(RESOURCES, 'linux', 'x64', layout({}))).toBeUndefined();
  });

  it('stands aside in development, where the SDK resolves itself correctly', () => {
    expect(
      bundledSdkExecutablePath(null, 'linux', 'x64', () => {
        throw new Error('readdir must not be called when there is no asar');
      }),
    ).toBeUndefined();
  });
});
