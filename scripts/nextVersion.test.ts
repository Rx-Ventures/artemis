/**
 * What the release classifier calls what.
 *
 * The rules it encodes are this repo's own, applied by hand until now: a release
 * that grows a surface or takes one away is a minor, everything else that ships
 * is a patch, and a major is a statement someone makes rather than something a
 * tool talks itself into.
 *
 * Every case here is built from literals rather than from a repository, which is
 * the point of the classifier being pure: the argument is about the rules, and a
 * fixture repo would make it about git.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBump,
  classifyChanges,
  isPrerelease,
  parseDiff,
  parseLog,
  satisfies,
  type Change,
} from './nextVersion.js';

const change = (over: Partial<Change> = {}): Change => ({
  message: 'A change with a sentence for a subject',
  files: [],
  added: [],
  removed: [],
  newFiles: [],
  ...over,
});

describe('classifying a release', () => {
  it('calls a new IPC channel a minor', () => {
    const verdict = classifyChanges([
      change({
        files: ['packages/protocol/src/ipc.ts'],
        added: ["packages/protocol/src/ipc.ts   runsStopTask: 'artemis:runs:stop-task',"],
      }),
    ]);

    expect(verdict.bump).toBe('minor');
    expect(verdict.reasons[0]).toContain('runsStopTask');
  });

  it('calls a new event variant a minor', () => {
    // Every exhaustive switch in the app has to grow a case for one of these,
    // which is the definition of a surface changing.
    const verdict = classifyChanges([
      change({
        files: ['packages/protocol/src/events.ts'],
        added: ['packages/protocol/src/events.ts   | BackgroundTasksEvent'],
      }),
    ]);

    expect(verdict.bump).toBe('minor');
  });

  it('calls new public API a minor, and a removal one too', () => {
    const added = classifyChanges([
      change({
        files: ['packages/core/src/adapters/taskLedger.ts'],
        added: ['packages/core/src/adapters/taskLedger.ts export class TaskLedger {'],
      }),
    ]);
    const removed = classifyChanges([
      change({
        files: ['packages/core/src/adapters/types.ts'],
        removed: ['packages/core/src/adapters/types.ts export interface LegacyThing {'],
      }),
    ]);

    // Taking away something people were using is the kind of change a version
    // number has to warn about — the rule this repo already applied by hand when
    // a setting left with the bar it configured.
    expect(added.bump).toBe('minor');
    expect(removed.bump).toBe('minor');
    expect(removed.reasons[0]).toContain('removed');
  });

  it('calls a brand-new renderer surface a minor', () => {
    const verdict = classifyChanges([
      change({
        files: ['apps/desktop/renderer/src/components/TasksPane.tsx'],
        newFiles: ['apps/desktop/renderer/src/components/TasksPane.tsx'],
        added: ['apps/desktop/renderer/src/components/TasksPane.tsx export function TasksPane() {'],
      }),
    ]);

    expect(verdict.bump).toBe('minor');
    expect(verdict.reasons.some((r) => r.includes('TasksPane'))).toBe(true);
  });

  it('does not call editing an existing surface a minor', () => {
    // The distinction the whole rule rests on, and the one the first version of
    // this got wrong by guessing: a state module that gained a single field is
    // work on something that already existed, and `newFiles` is git's answer
    // rather than an inference from "additions and no removals".
    const verdict = classifyChanges([
      change({
        files: [
          'apps/desktop/renderer/src/components/DockPane.tsx',
          'apps/desktop/renderer/src/state/pane.ts',
        ],
        added: ['apps/desktop/renderer/src/state/pane.ts   readonly tasks: readonly Task[];'],
      }),
    ]);

    expect(verdict.bump).toBe('patch');
  });

  it('calls an ordinary fix a patch', () => {
    const verdict = classifyChanges([
      change({
        files: ['apps/desktop/renderer/src/lib/sessionGroups.ts'],
        added: ['apps/desktop/renderer/src/lib/sessionGroups.ts   groups.sort(byName);'],
        removed: ['apps/desktop/renderer/src/lib/sessionGroups.ts   groups.sort(byRecency);'],
      }),
    ]);

    expect(verdict.bump).toBe('patch');
    expect(verdict.reasons).toEqual(['changes to shipped code']);
  });

  it('calls a release of notes and tests nothing at all', () => {
    // A version number on an empty box is worse than no release: it invites
    // everyone to update for nothing.
    const verdict = classifyChanges([
      change({
        files: ['.github/RELEASE_NOTES.md', 'packages/core/src/sessions/registry.test.ts'],
        added: ['packages/core/src/sessions/registry.test.ts export const NOT_REAL = 1;'],
      }),
    ]);

    expect(verdict.bump).toBe('none');
  });

  it('never infers a major, however much moved', () => {
    // At 0.x a major is a statement about the project, and a tool that talked
    // itself into one would be wrong in the most expensive direction available.
    const verdict = classifyChanges([
      change({
        files: ['packages/protocol/src/ipc.ts'],
        added: [
          "packages/protocol/src/ipc.ts   a: 'artemis:a:b'",
          'packages/protocol/src/events.ts   | SomethingEvent',
        ],
        removed: ['packages/core/src/adapters/types.ts export interface Gone {'],
      }),
    ]);

    expect(verdict.bump).toBe('minor');
  });

  it('lets a commit declare the answer outright', () => {
    const verdict = classifyChanges([
      change({
        message: 'The thing changes shape\n\nRelease: major\n',
        files: ['apps/desktop/renderer/src/lib/format.ts'],
        added: ['apps/desktop/renderer/src/lib/format.ts   const x = 1;'],
      }),
    ]);

    expect(verdict.bump).toBe('major');
    expect(verdict.declaredBy).toBe('The thing changes shape');
    // What the diff said is kept rather than discarded: the declaration is a
    // decision, and the evidence it overrode is worth reading beside it.
    expect(verdict.reasons.some((r) => r.startsWith('also seen'))).toBe(true);
  });

  it('takes the highest declaration, so nothing can talk a release down', () => {
    const verdict = classifyChanges([
      change({ message: 'One\n\nRelease: patch\n' }),
      change({ message: 'Two\n\nRelease: minor\n' }),
    ]);

    expect(verdict.bump).toBe('minor');
    expect(verdict.declaredBy).toBe('Two');
  });
});

describe('turning a verdict into a number', () => {
  it('moves the part it is meant to, and zeroes what follows', () => {
    expect(applyBump('v0.10.0', 'patch')).toBe('0.10.1');
    expect(applyBump('v0.10.1', 'minor')).toBe('0.11.0');
    expect(applyBump('0.10.1', 'major')).toBe('1.0.0');
    expect(applyBump('v0.10.1', 'none')).toBe('0.10.1');
  });

  it('accepts a bump bigger than the changes call for, and refuses a smaller one', () => {
    // Deciding to ship a minor where a patch would do is a judgement someone is
    // allowed to make. Shipping a patch over a new surface is the mistake.
    expect(satisfies('v0.10.0', '0.10.1', 'patch')).toBe(true);
    expect(satisfies('v0.10.0', '0.11.0', 'patch')).toBe(true);
    expect(satisfies('v0.10.0', '0.10.1', 'minor')).toBe(false);
    expect(satisfies('v0.10.0', '0.10.0', 'patch')).toBe(false);
  });

  it('reads a prerelease as the version it rehearses', () => {
    // Before this, `'1.0.0-beta.1'.split('.').map(Number)` gave `[1, 0, NaN,
    // NaN]`, and NaN compares false against everything — so a beta registered
    // as no bump at all and the release script refused to cut it.
    expect(isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(isPrerelease('v1.0.0')).toBe(false);

    expect(satisfies('v0.20.0', '1.0.0-beta.1', 'major')).toBe(true);
    expect(satisfies('v0.20.0', '0.20.1-beta.1', 'minor')).toBe(false);
    // And the promotion: measured from the last *stable* tag, the final release
    // is the same major the beta was, so cutting it needs no override.
    expect(satisfies('v0.20.0', '1.0.0', 'major')).toBe(true);
    expect(applyBump('v1.0.0-beta.3', 'patch')).toBe('1.0.1');
  });
});

describe('attributing diff lines to files', () => {
  it('credits a modification to its b-side path', () => {
    const { added, removed } = parseDiff(
      [
        'diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts',
        '--- a/packages/core/src/index.ts',
        '+++ b/packages/core/src/index.ts',
        '@@ -1 +1 @@',
        '-export const old = 1;',
        '+export const renamed = 1;',
      ].join('\n'),
    );

    expect(added).toEqual(['packages/core/src/index.ts export const renamed = 1;']);
    expect(removed).toEqual(['packages/core/src/index.ts export const old = 1;']);
  });

  /*
   * A deletion's b-side header is `+++ /dev/null`, never `+++ b/…`. Reading
   * only the b-side leaves the previous file's path in place, and the deleted
   * file's removed lines land on it — a deleted package export slips past the
   * "public API removed" rule, and a deleted renderer file can trip it.
   */
  it('credits a deleted file its own removed lines, not the previous file', () => {
    const { removed } = parseDiff(
      [
        'diff --git a/README.md b/README.md',
        '--- a/README.md',
        '+++ b/README.md',
        '@@ -1 +1 @@',
        '-Old sentence.',
        '+New sentence.',
        'diff --git a/packages/core/src/gone.ts b/packages/core/src/gone.ts',
        'deleted file mode 100644',
        '--- a/packages/core/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-export function gone(): void {}',
        '-export const alsoGone = 2;',
      ].join('\n'),
    );

    expect(removed).toContain('packages/core/src/gone.ts export function gone(): void {}');
    expect(removed).toContain('packages/core/src/gone.ts export const alsoGone = 2;');
    expect(removed.filter((line) => line.startsWith('README.md'))).toEqual([
      'README.md Old sentence.',
    ]);
  });

  it('credits a new file its added lines and nothing to a phantom a-side', () => {
    const { added, removed } = parseDiff(
      [
        'diff --git a/packages/core/src/born.ts b/packages/core/src/born.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/packages/core/src/born.ts',
        '@@ -0,0 +1 @@',
        '+export const born = 1;',
      ].join('\n'),
    );

    expect(added).toEqual(['packages/core/src/born.ts export const born = 1;']);
    expect(removed).toEqual([]);
  });
});

describe('telling paths from prose in the log', () => {
  // The raw strings here are what `git log --format=%x00%B --name-only` prints:
  // NUL, the message, a blank line, then the commit's paths one per line.

  it('counts a root-level file, so a dependency-only release is not "none"', () => {
    // The old shape-based rule required a `/`, which no root-level path has —
    // so a release that only moved package.json and the lockfile classified as
    // `none`, and release.ts refused to cut it with no override on offer.
    const changes = parseLog('\0The dependencies move up a notch\n\n\npackage.json\npnpm-lock.yaml\n', [
      'package.json',
      'pnpm-lock.yaml',
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.files).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(classifyChanges(changes).bump).toBe('patch');
  });

  it('leaves a body line that merely looks like a path in the message', () => {
    // `apps/desktop/main/engine.ts` below is prose — a bare path-shaped line in
    // a commit body — and git's endpoint diff never mentions it. The old parse
    // filed it as a touched file on shape alone.
    const changes = parseLog(
      '\0The adapter learns to retry\n\nBlame lands in\napps/desktop/main/engine.ts\notherwise.\n\n\npackages/core/src/adapters/claude.ts\n',
      ['packages/core/src/adapters/claude.ts'],
    );

    expect(changes[0]?.files).toEqual(['packages/core/src/adapters/claude.ts']);
    expect(changes[0]?.message).toContain('apps/desktop/main/engine.ts');
  });

  it('does not split on a body that contains the old separator', () => {
    // The previous delimiter was the literal string ` COMMIT `, which any
    // commit message may contain — this one does, twice. Git strips NUL from
    // messages, so `%x00` is the one boundary a body cannot fake.
    const changes = parseLog(
      '\0The parser stops guessing\n\nSplitting on COMMIT broke a body saying COMMIT mid-sentence.\n\n\nscripts/nextVersion.ts\n' +
        '\0The second commit survives intact\n\n\npackage.json\n',
      ['scripts/nextVersion.ts', 'package.json'],
    );

    expect(changes).toHaveLength(2);
    expect(changes[0]?.message).toContain(' COMMIT ');
    expect(changes[0]?.files).toEqual(['scripts/nextVersion.ts']);
    expect(changes[1]?.files).toEqual(['package.json']);
  });
});
