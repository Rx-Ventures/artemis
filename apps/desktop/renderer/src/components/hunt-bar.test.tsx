/**
 * @vitest-environment jsdom
 *
 * What the bow at the foot of the conversation is doing, and when.
 *
 * The hunt bar is decoration, but it is decoration that *reports*: firing
 * means a run is going, holding means the run is parked on the user, rest
 * means it finished. Each assertion here is about a state where the wrong
 * pose is a small lie:
 *
 *  - **A pane that has never run shows no bow at all.** The strip buys its
 *    16px only once there is a run to report; a mascot on an empty pane is
 *    chrome with nothing to say.
 *  - **A live run fires; a parked run holds.** The drawn-and-motionless pose
 *    is the one that earns the animation its keep — if `awaiting_permission`
 *    kept looping arrows, the bar would say "working" about a run that is
 *    waiting on you.
 *  - **A finished run comes to rest and stays.** The animation stopping — not
 *    the element vanishing — is the requested behaviour, and the arrow being
 *    gone is what distinguishes "done" from "aiming".
 *
 * The poses are asserted through `data-pose` plus the classes and attributes
 * the CSS actually keys on (`hunt-flight`, `hunt-nock`, the string's `d`),
 * because jsdom runs no animations: what can regress here is the *wiring* —
 * status to pose, pose to markup — and that is exactly what these read.
 *
 * As with the other component tests, `renderer/tsconfig.json` excludes these,
 * so `pnpm typecheck` never sees them and the assertions stay behavioural.
 */

import type { RunStatus } from '@rx-artemis/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { HuntBar } from '@/components/HuntBar';
import { seedApp } from '@/state/testkit';

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

/** Seed a window whose one pane has a run in the given state — or none. */
function setUp(status: RunStatus | null): void {
  seedApp({
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    permissionQueue: [],
    run:
      status === null
        ? null
        : {
            runId: 'run_1',
            status,
            providerId: 'claude',
            profileId: 'p1',
            cwd: '/w',
            capabilities: CAPABILITIES,
            startedAt: 0,
          },
  });
}

function bar(): HTMLElement | null {
  return document.querySelector('[data-slot="hunt-bar"]');
}

afterEach(cleanup);

describe('the hunt bar', () => {
  it('does not exist before the pane has ever run', () => {
    setUp(null);
    render(<HuntBar />);

    expect(bar()).toBeNull();
  });

  it('fires while the run is live', () => {
    setUp('running');
    render(<HuntBar />);

    const strip = bar();
    expect(strip?.getAttribute('data-pose')).toBe('firing');
    // The two moving parts the CSS animates: an arrow on the string and an
    // arrow in flight. Either missing and the loop is a bow waving at nothing.
    expect(strip?.querySelector('.hunt-nock')).not.toBeNull();
    expect(strip?.querySelector('.hunt-flight')).not.toBeNull();
  });

  it('fires from the very start of the run, before the first event', () => {
    setUp('starting');
    render(<HuntBar />);

    expect(bar()?.getAttribute('data-pose')).toBe('firing');
  });

  it('holds at full draw while the run waits on a permission', () => {
    setUp('awaiting_permission');
    render(<HuntBar />);

    const strip = bar();
    expect(strip?.getAttribute('data-pose')).toBe('holding');
    // Drawn as an attribute, not an animation: the string is bent…
    expect(strip?.querySelector('path[d="M5 2 L2 8 L5 14"]')).not.toBeNull();
    // …and nothing loops. A flying arrow here would claim progress the run
    // is not making.
    expect(strip?.querySelector('.hunt-flight')).toBeNull();
    expect(strip?.querySelector('.hunt-nock')).toBeNull();
  });

  it('comes to rest — still on screen, nothing moving — when the run ends', () => {
    setUp('ended');
    render(<HuntBar />);

    const strip = bar();
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute('data-pose')).toBe('rest');
    // String straight, arrow loosed and gone, no animation classes anywhere.
    expect(strip?.querySelector('path[d="M5 2 L5 8 L5 14"]')).not.toBeNull();
    expect(strip?.querySelector('.hunt-flight')).toBeNull();
    expect(strip?.querySelector('.hunt-nock')).toBeNull();
    expect(strip?.querySelector('.hunt-string')).toBeNull();
    expect(strip?.querySelector('.hunt-recoil')).toBeNull();
  });
});
