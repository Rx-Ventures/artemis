/**
 * Handing the work to an account that cannot have the conversation.
 * ============================================================================
 *
 * A session id only resolves under the profile whose config directory holds
 * its transcript, so the ordinary hand-off — which moves the conversation
 * intact — stops at that boundary. Every account on the other side of it can
 * still do the work, given the briefing, and `seedHandoffToProfile` is that
 * door: the agent writes the hand-off document, and when that run ends a new
 * conversation opens on the target account in the same folder.
 *
 * Two properties are pinned here because both are invisible until they are
 * wrong, and both would fail quietly:
 *
 *  - the *unreachable* accounts are the seedable ones, which is the exact
 *    inverse of the ordinary candidate list;
 *  - the intent survives the gap between the two runs, and spends itself
 *    exactly once when the first one ends.
 */

import { describe, expect, it } from 'vitest';
import type { ProfileMetadata } from '@rx-artemis/protocol';

import { handoffCandidates, seedCandidates } from './handoffTargets';

const profile = (id: string): ProfileMetadata =>
  ({ id, label: id, providerId: 'claude', configDir: `/u/.${id}` }) as ProfileMetadata;

const PROFILES = [profile('here'), profile('shares-store'), profile('other-provider')];
// `here` is the account in use; `shares-store` can read the transcript;
// `other-provider` cannot.
const reaches = (id: string): boolean => id === 'shares-store';

describe('who can be handed what', () => {
  it('offers the reachable accounts the conversation, and never the active one', () => {
    const moving = handoffCandidates(PROFILES, 'here', reaches).map((p) => p.id);
    expect(moving).toEqual(['shares-store']);
  });

  it('offers the unreachable accounts a seeded conversation instead of nothing', () => {
    // The whole point: before this existed, an account in another config
    // directory was filtered out of the picker and the feature simply stopped
    // at the provider boundary.
    const seeding = seedCandidates(PROFILES, 'here', reaches).map((p) => p.id);
    expect(seeding).toEqual(['other-provider']);
  });

  it('never offers one account both answers', () => {
    // They partition: an account either reaches the transcript or it does not,
    // and a row appearing in both lists would be asking the user to choose
    // between a move and a reseed of the same thing.
    const moving = new Set(handoffCandidates(PROFILES, 'here', reaches).map((p) => p.id));
    const seeding = seedCandidates(PROFILES, 'here', reaches).map((p) => p.id);
    expect(seeding.some((id) => moving.has(id))).toBe(false);
  });

  it('leaves the active account out of both', () => {
    const all = [
      ...handoffCandidates(PROFILES, 'here', reaches),
      ...seedCandidates(PROFILES, 'here', reaches),
    ].map((p) => p.id);
    expect(all).not.toContain('here');
  });
});
