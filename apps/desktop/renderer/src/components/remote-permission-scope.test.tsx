/**
 * @vitest-environment jsdom
 *
 * What a permission card may offer when the run is on someone else's machine.
 *
 * A suggested rule arrives from the provider CLI with its own scope, and that
 * scope is often durable — `project`, `local`, `user` — because locally those
 * are what "stop asking me about this" should write. Over a connection token
 * they cannot be honoured: a durable rule writes to the *serving* machine's
 * settings, and both the server's parser and `guardRemoteDecision` refuse the
 * whole decision when one appears.
 *
 * That refusal is a boundary and stays. This pins the other half: the card must
 * not build a decision the boundary will reject, which is what made "Allow for
 * this session" fail on every remote prompt and left "Approve once" as the only
 * answer that worked.
 */

import { describe, expect, it } from 'vitest';

import type { PermissionRuleUpdate } from '@rx-artemis/protocol';

const { scopedForRun } = await import('@/components/InlinePermission');

const rule = (scope?: string): PermissionRuleUpdate =>
  ({ type: 'addRules', rules: [{ toolName: 'Bash' }], ...(scope === undefined ? {} : { scope }) }) as unknown as PermissionRuleUpdate;

describe('scopedForRun', () => {
  it('narrows a durable scope to the run, on a remote run', () => {
    const narrowed = scopedForRun([rule('project'), rule('user'), rule('local')], true);
    expect(narrowed.map((update) => update.scope)).toEqual(['session', 'session', 'session']);
  });

  it('leaves alone what a connection token may already carry', () => {
    // `once` and `session` are exactly the two the server accepts, so touching
    // them would be churn — and `undefined` means the decision's own scope.
    const kept = [rule('once'), rule('session'), rule(undefined)];
    expect(scopedForRun(kept, true)).toEqual(kept);
  });

  it('changes nothing at all on a local run', () => {
    // Durable is the right answer on your own machine, and is the whole point
    // of the suggestion. Identity, not a copy: nothing here needs rebuilding.
    const suggestions = [rule('project'), rule('user')];
    expect(scopedForRun(suggestions, false)).toBe(suggestions);
  });
});
