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

import { applyBump, classifyChanges, satisfies, type Change } from './nextVersion.js';

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
});
