/**
 * Turning `ExitPlanMode` back into a plan.
 *
 * The tool parks a run on the permission callback like any other, but what it
 * carries is a markdown document and what it wants is sign-off. Decoded, the UI
 * can render the plan and offer "approve" and "keep planning"; not decoded, the
 * user gets the document JSON-escaped in a code block under a heading reading
 * `arguments`, above a button labelled "Approve once".
 *
 * So this function's whole job is the difference between those two cards, and
 * its failure mode is quiet: every branch that gives up returns `undefined` and
 * falls back to the arguments card. These tests are what keep "gives up" honest
 * — a decoder that returned `undefined` for real input would degrade silently,
 * and the only evidence would be a user wondering why their plan looks like a
 * blob.
 *
 * The `INPUT` fixture is a real payload's shape, sampled from stored sessions
 * rather than invented: `plan` plus `planFilePath`, with `allowedPrompts`
 * sometimes along for the ride.
 */

import { describe, expect, it } from 'vitest';

import type { JsonObject, PlanProposal } from '@rx-artemis/protocol';

import { buildPermissionRequest, readPlanProposal } from '../mapper.js';

const PLAN = '# Replace the polling loop\n\n## Context\n\nIt runs every 2s regardless.';

/** The arguments the tool actually arrives with. */
const INPUT: JsonObject = {
  plan: PLAN,
  planFilePath: '/Users/demo/.claude/plans/harmonic-gathering-pumpkin.md',
};

/* -------------------------------------------------------------------------- */
/* Decoding                                                                   */
/* -------------------------------------------------------------------------- */

describe('readPlanProposal', () => {
  it('decodes the plan and where the provider saved it', () => {
    expect(readPlanProposal('ExitPlanMode', INPUT)).toEqual({
      plan: PLAN,
      planPath: '/Users/demo/.claude/plans/harmonic-gathering-pumpkin.md',
    });
  });

  it('ignores every other tool', () => {
    expect(readPlanProposal('Bash', INPUT)).toBeUndefined();
  });

  /**
   * The provider has changed its mind about this field before — the SDK's own
   * types no longer declare it — so a plan without it still has to decode. The
   * path is a convenience for opening the plan later, not part of the ask.
   */
  it('decodes a plan with no file path', () => {
    expect(readPlanProposal('ExitPlanMode', { plan: PLAN })).toEqual({ plan: PLAN });
  });

  it('drops a file path that is not a usable string', () => {
    expect(readPlanProposal('ExitPlanMode', { plan: PLAN, planFilePath: '' })).toEqual({
      plan: PLAN,
    });
    expect(readPlanProposal('ExitPlanMode', { plan: PLAN, planFilePath: 42 })).toEqual({
      plan: PLAN,
    });
  });

  /**
   * A plan card with nothing in it is worse than the arguments card, which at
   * least shows what really arrived. Every one of these falls back.
   */
  it.each([
    ['no plan at all', {}],
    ['a plan that is not a string', { plan: { text: PLAN } }],
    ['an empty plan', { plan: '' }],
    ['a plan that is only whitespace', { plan: '   \n  ' }],
  ])('gives up on %s', (_label, input) => {
    expect(readPlanProposal('ExitPlanMode', input as JsonObject)).toBeUndefined();
  });

  /**
   * `allowedPrompts` is marked "Deprecated: no longer used" by the SDK, and
   * rendering a list of pre-authorised shell commands the provider has stopped
   * acting on would be a security-shaped claim that is not true. It is read as
   * nothing at all, and its presence does not disturb the rest.
   */
  it('ignores the deprecated allowedPrompts entirely', () => {
    const withPrompts: JsonObject = {
      ...INPUT,
      allowedPrompts: [{ tool: 'Bash', prompt: 'run the test suite' }],
    };
    expect(readPlanProposal('ExitPlanMode', withPrompts)).toEqual(
      readPlanProposal('ExitPlanMode', INPUT),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* On the request                                                             */
/* -------------------------------------------------------------------------- */

describe('buildPermissionRequest', () => {
  it('carries the decoded plan, so the UI never re-parses the arguments', () => {
    const request = buildPermissionRequest({
      id: 'run-1:perm:1',
      runId: 'run-1',
      toolName: 'ExitPlanMode',
      input: INPUT,
      requestedAt: 1_700_000_000_000,
    });

    expect(request.plan).toEqual<PlanProposal>({
      plan: PLAN,
      planPath: '/Users/demo/.claude/plans/harmonic-gathering-pumpkin.md',
    });
    // Still verbatim underneath. The decoded plan is a rendering aid, not a
    // replacement for what the provider actually asked for.
    expect(request.input).toEqual(INPUT);
    // And it is not mistaken for the other kind of park.
    expect(request.question).toBeUndefined();
  });

  it('leaves plan unset for an ordinary tool call', () => {
    const request = buildPermissionRequest({
      id: 'run-1:perm:2',
      runId: 'run-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      requestedAt: 1_700_000_000_000,
    });
    expect(request.plan).toBeUndefined();
  });
});
