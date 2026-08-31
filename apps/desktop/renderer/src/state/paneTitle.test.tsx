/**
 * @vitest-environment jsdom
 *
 * A column is named by the conversation in it, not by how it got there.
 * ============================================================================
 *
 * The bug this pins: the first pane in a split stayed titled "New session"
 * while the sidebar row for the very same conversation showed the name the
 * provider had already given it.
 *
 * Both surfaces that name a column — the caption under a split pane's top edge
 * and the window header's title — read `resumeSessionId` and nothing else. That
 * field is written when a session is *resumed*, and otherwise promoted out of
 * the run only when the run *ends*, so a conversation started in this window
 * has no `resumeSessionId` for the whole of its first turn. The id is there the
 * moment `session.started` lands; it is just on `run.sessionId`, which is
 * precisely why every other question about a column's identity —
 * `paneForSession`, `syncRunningSessions`, `syncOpenSessions` — is matched
 * against both.
 *
 * A split is what made it impossible to miss rather than merely wrong. The pane
 * opened beside goes through `resumeSession`, which sets `resumeSessionId`
 * synchronously, so the *new* column was named correctly and the one that had
 * been working for twenty minutes next to it was not — the exact asymmetry the
 * report describes.
 *
 * Held at both altitudes on purpose. `conversationName` is asserted directly,
 * because that is where the rule lives and where a future caller will look for
 * it; the caption is asserted through a rendered window, because a selector
 * nothing reads is not a fix.
 *
 * Same caveat as the neighbouring suites: `renderer/tsconfig.json` excludes
 * test files, so `pnpm typecheck` never sees this one and the assertions are
 * behavioural.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkingArea } from '@/components/WorkingArea';
import {
  allPanes,
  closePane,
  conversationName,
  focusedPane,
  paneCount,
  splitPane,
  useApp,
} from './store';
import { paneState, setPaneState } from './pane';

/* Radix's floating layer needs observers jsdom does not implement. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const CAPS = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

const CLAUDE = {
  id: 'claude',
  label: 'Claude',
  capabilities: CAPS,
  models: [],
  effortLevels: [],
  available: true,
};

const PROFILE = { id: 'p1', label: 'Personal', providerId: 'claude', configDir: '/u/.p1' };

/*
 * A bridge that answers nothing interesting.
 *
 * `splitPane` refreshes the new column's models and commands, and the rendered
 * window asks after live runs. None of that is what is under test, and
 * `resolveBridge` memoises its binding on the first call — so one stub is
 * installed here rather than per test.
 */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  runs: {
    list: async () => ({ ok: true, value: { runs: [] } }),
    liveWork: async () => ({ ok: true, value: { sessionIds: [], working: [], delegated: [] } }),
    onEvent: () => () => undefined,
  },
  sessions: {
    listAll: async () => ({ ok: true, value: { sessions: [], hasMore: false } }),
    messages: async () => ({ ok: true, value: { events: [], hasMore: false } }),
  },
};

function session(id: string, title: string) {
  return { id, title, cwd: '/w', profileId: 'p1', providerId: 'claude', updatedAt: 1_000 };
}

/** The run a conversation started in this window carries while it works. */
function liveRun(sessionId: string | undefined) {
  return {
    runId: 'r1',
    status: 'running',
    providerId: 'claude',
    profileId: 'p1',
    cwd: '/w',
    capabilities: CAPS,
    startedAt: 1_000,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

/** Collapse back to a single pane between tests, without touching the first one. */
function collapse(): void {
  for (let guard = 0; guard < 20 && paneCount() > 1; guard += 1) {
    const last = allPanes()[paneCount() - 1];
    if (last) closePane(last.id);
  }
}

beforeEach(() => {
  cleanup();
  collapse();
  useApp.setState({
    providers: [CLAUDE],
    profiles: [PROFILE],
    sessions: [session('s1', 'Wire the seam')],
    background: [],
    banners: [],
    paneLayout: {},
    booted: true,
  });
  setPaneState(focusedPane(), {
    cwd: '/w',
    activeProviderId: 'claude',
    activeProfileId: 'p1',
    resumeSessionId: null,
    run: null,
    draft: '',
  });
});

describe('what a column is called', () => {
  it('names a conversation this window started, before its first run ends', () => {
    // The state a pane is in from `session.started` until `run.end`: the id
    // exists and the sidebar already lists it, but nothing has promoted it into
    // `resumeSessionId` yet.
    setPaneState(focusedPane(), { run: liveRun('s1') });

    expect(conversationName(paneState(focusedPane()))).toBe('Wire the seam');
  });

  it('names a resumed conversation', () => {
    setPaneState(focusedPane(), { resumeSessionId: 's1' });

    expect(conversationName(paneState(focusedPane()))).toBe('Wire the seam');
  });

  it('says New session when there is no conversation to name', () => {
    expect(conversationName(paneState(focusedPane()))).toBe('New session');
  });

  it('says New session while a run has an id the listing has not caught up with', () => {
    // `refreshSessionsSoon` is deliberately delayed — the provider is still
    // writing the file — so there is a window where the column holds an id
    // nothing can name. It has not been given a name yet, and says so.
    setPaneState(focusedPane(), { run: liveRun('s-unlisted') });

    expect(conversationName(paneState(focusedPane()))).toBe('New session');
  });

  it('says Resumed session for a session the listing does not hold', () => {
    // Another provider's history, an archived row, a deleted one. There *is* a
    // conversation here, which is the difference from the case above.
    setPaneState(focusedPane(), { resumeSessionId: 's-elsewhere' });

    expect(conversationName(paneState(focusedPane()))).toBe('Resumed session');
  });

  it('keeps the parent’s name through the moment a fork has no name of its own', () => {
    // A fork's run mints an id the listing cannot answer for yet, while
    // `resumeSessionId` still names what it branched from. The pair is read in
    // order, so the parent's title carries the column rather than a placeholder.
    setPaneState(focusedPane(), { resumeSessionId: 's1', run: liveRun('s1-fork') });

    expect(conversationName(paneState(focusedPane()))).toBe('Wire the seam');
  });
});

describe('splitting beside a working conversation', () => {
  it('leaves the first pane naming its own session', () => {
    const first = focusedPane();
    setPaneState(first, { run: liveRun('s1') });

    const second = splitPane('right');

    expect(second).not.toBeNull();
    expect(allPanes()[0]?.id).toBe(first.id);
    expect(conversationName(paneState(first))).toBe('Wire the seam');
    // And the blank column beside it is the one with nothing to name.
    expect(conversationName(paneState(second!))).toBe('New session');
  });

  it('writes that name into the first pane’s caption', () => {
    const first = focusedPane();
    setPaneState(first, { run: liveRun('s1') });
    splitPane('right');

    const { container } = render(
      <TooltipProvider>
        <WorkingArea />
      </TooltipProvider>,
    );

    // The captions only exist in a split — with one pane the window header
    // already answers "what am I looking at". The first one is the pane that
    // was there before the split.
    const captions = [...container.querySelectorAll('section[aria-label="Conversation"]')].map(
      (pane) => pane.querySelector('span.flex-1')?.textContent,
    );

    expect(captions).toEqual(['Wire the seam', 'New session']);
  });
});
