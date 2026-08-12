/**
 * Recognising scratch space, against this machine's real temporary root.
 *
 * `tmpdir()` rather than a fixed string, because the answer is different on
 * every platform this runs on and the interesting one is the least guessable:
 * macOS puts it at `/var/folders/<pair>/<hash>/T`, which contains neither "tmp"
 * nor anything else a hand-written pattern would think to look for.
 *
 * The claim being tested is a *judgement about a path*, not about a directory,
 * so nothing here creates one. That is the point of the module: the paths it
 * has to get right are mostly deleted by the time it sees them.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isTemporaryPath } from './temp.js';

const TEMP = tmpdir();

describe('isTemporaryPath', () => {
  it('recognises this machine’s temporary root', () => {
    expect(isTemporaryPath(TEMP)).toBe(true);
  });

  it('recognises a directory inside it', () => {
    // The real shape: something made by `mkdtemp` and long since removed.
    expect(isTemporaryPath(join(TEMP, 'artemis-attach-YAMHfo'))).toBe(true);
    expect(isTemporaryPath(join(TEMP, 'agent-run-1', 'checkout', 'src'))).toBe(true);
  });

  it('recognises `/tmp`, which tools hard-code whatever TMPDIR says', () => {
    expect(isTemporaryPath('/tmp')).toBe(true);
    expect(isTemporaryPath('/tmp/scratch/project')).toBe(true);
  });

  it('leaves an ordinary project alone', () => {
    expect(isTemporaryPath('/Users/me/code/artemis')).toBe(false);
    expect(isTemporaryPath('/home/me/code/artemis')).toBe(false);
  });

  it('does not mistake a neighbour for a child', () => {
    // A string prefix would call both of these temporary, and each is somebody's
    // real project quietly missing from their folder menu.
    expect(isTemporaryPath('/tmpfoo/project')).toBe(false);
    expect(isTemporaryPath(`${TEMP}-backup/project`)).toBe(false);
  });

  it('does not judge a relative path', () => {
    // Resolving it against *this* process's cwd would answer about a directory
    // the caller never named. Same rule as `describeWorkspace`.
    expect(isTemporaryPath('tmp/thing')).toBe(false);
    expect(isTemporaryPath('src/components')).toBe(false);
  });

  it('survives the empty and the blank', () => {
    expect(isTemporaryPath('')).toBe(false);
    expect(isTemporaryPath('   ')).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin')('macOS symlink twins', () => {
  it('recognises the path spelled either way', () => {
    // `/var` and `/tmp` are symlinks into `/private`, so the same directory
    // arrives spelled short from `tmpdir()` and long from anything that has
    // been through `realpath`. Both have to count or half of them slip through.
    const long = TEMP.startsWith('/private') ? TEMP : `/private${TEMP}`;
    const short = TEMP.startsWith('/private') ? TEMP.slice('/private'.length) : TEMP;

    expect(isTemporaryPath(join(long, 'run-1'))).toBe(true);
    expect(isTemporaryPath(join(short, 'run-1'))).toBe(true);
    expect(isTemporaryPath('/private/tmp/scratch')).toBe(true);
  });
});
