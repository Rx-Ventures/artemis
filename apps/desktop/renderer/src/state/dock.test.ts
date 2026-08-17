/**
 * The dock's ownership and tab rules.
 *
 * These are pure functions over a description of what the columns are showing,
 * which is the whole reason `dock.ts` is shaped the way it is: every rule below
 * is an edge case about conversations moving between columns, and none of them
 * needs a window, a store or a running shell to state.
 *
 * The four claims worth pinning, because each fails silently:
 *
 *  - **A terminal follows its conversation**, including into a different column
 *    after a resume. Getting this wrong strands a running shell with no tab.
 *  - **A conversation with no run yet still owns things.** This is the ordinary
 *    case for ⌘J on a fresh session, and an ownership check that assumed a run
 *    id would drop the tab on the frame it was created.
 *  - **Adoption happens once, and only from the right run.** A stale adoption
 *    re-homes a tab onto work it has nothing to do with.
 *  - **Closing a tab activates its left neighbour**, not the first tab and not
 *    nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  learnSessionId,
  nextActiveTab,
  ownerIsShown,
  PREVIEW_TAB,
  sameTab,
  tabKey,
  visibleTabs,
  type BrowserRecord,
  type DockOwner,
  type DockTab,
  type ShownConversation,
  type TerminalRecord,
} from './dock';

/** A terminal record, with only the fields these rules look at. */
function terminal(id: string, owner: DockOwner): TerminalRecord {
  return {
    info: { id, shell: '/bin/zsh', cwd: '/w', startedAt: 0, exited: false },
    owner,
    title: 'zsh',
    exited: false,
  };
}

const term = (id: string): DockTab => ({ kind: 'terminal', id });

describe('tab identity', () => {
  it('tells the preview apart from a terminal, and terminals from each other', () => {
    expect(sameTab(PREVIEW_TAB, { kind: 'preview' })).toBe(true);
    expect(sameTab(term('a'), term('a'))).toBe(true);
    expect(sameTab(term('a'), term('b'))).toBe(false);
    expect(sameTab(PREVIEW_TAB, term('a'))).toBe(false);
    expect(sameTab(null, null)).toBe(true);
    expect(sameTab(null, PREVIEW_TAB)).toBe(false);
  });

  it('gives keys that cannot collide across the two kinds', () => {
    expect(tabKey(PREVIEW_TAB)).not.toBe(tabKey(term('preview')));
  });
});

describe('ownerIsShown', () => {
  /*
   * The durable case. A session id outlives the run that produced it, so a
   * conversation resumed into a *different* column still matches — which is what
   * makes a terminal feel like it belongs to the project rather than to a
   * rectangle on screen.
   */
  it('follows a session into whichever column it is showing in', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1', sessionId: 'sess1' };
    const elsewhere: readonly ShownConversation[] = [
      { paneId: 'pane9', runId: 'run7', sessionId: 'sess1' },
    ];
    expect(ownerIsShown(owner, elsewhere)).toBe(true);
  });

  it('is not shown when its session is nowhere on screen', () => {
    const owner: DockOwner = { paneId: 'pane1', sessionId: 'sess1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1', sessionId: 'other' }])).toBe(false);
    expect(ownerIsShown(owner, [])).toBe(false);
  });

  /*
   * Before `session.started` there is nothing durable to match on, so identity
   * is the run *in the column it started in*. A pane whose run has been replaced
   * is a different conversation even though it is the same column.
   */
  it('falls back to the run, in the column it started in', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run2' }])).toBe(false);
    expect(ownerIsShown(owner, [{ paneId: 'pane2', runId: 'run1' }])).toBe(false);
  });

  /*
   * The ordinary case for ⌘J on a fresh window: no run and no session, so the
   * pane is the whole identity — and it stays the whole identity as that column
   * is used.
   *
   * The last two assertions are the interesting ones. A conversation starting in
   * that column does *not* orphan the terminal, which is a deliberate departure
   * from how the run-identified case behaves: there was no conversation for the
   * shell to belong to when it was opened, and making it vanish the first time
   * the user pressed Enter would read as a crash.
   */
  it('identifies a conversation that has never run anything by its pane, and keeps it', () => {
    const owner: DockOwner = { paneId: 'pane1' };
    expect(ownerIsShown(owner, [{ paneId: 'pane1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane2' }])).toBe(false);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', runId: 'run1' }])).toBe(true);
    expect(ownerIsShown(owner, [{ paneId: 'pane1', sessionId: 'sess1' }])).toBe(true);
  });

  /*
   * The other side of that coin, and the reason `learnSessionId` refuses to
   * adopt without a run: a column-owned terminal must not quietly become some
   * session's terminal, or closing that session would take an unrelated shell
   * with it.
   */
  it('never lets a column-owned tab adopt whichever session turns up', () => {
    expect(learnSessionId({ paneId: 'pane1' }, [{ paneId: 'pane1', sessionId: 'sess1' }])).toBeNull();
  });
});

describe('learnSessionId', () => {
  it('adopts the id its own run has learned', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1' };
    const shown = [{ paneId: 'pane1', runId: 'run1', sessionId: 'sess1' }];
    expect(learnSessionId(owner, shown)).toBe('sess1');
  });

  it('has nothing to adopt once it has one', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1', sessionId: 'sess1' };
    expect(learnSessionId(owner, [{ paneId: 'pane1', runId: 'run1', sessionId: 'sess2' }])).toBeNull();
  });

  /*
   * The stale case. If the pane has moved on to another run, its session id
   * belongs to work this owner has nothing to do with, and taking it would
   * silently re-home the tab onto a different conversation.
   */
  it('refuses a session id from a run that has since been replaced', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1' };
    expect(learnSessionId(owner, [{ paneId: 'pane1', runId: 'run2', sessionId: 'sess2' }])).toBeNull();
  });

  it('has nothing to adopt when its pane is gone', () => {
    const owner: DockOwner = { paneId: 'pane1', runId: 'run1' };
    expect(learnSessionId(owner, [{ paneId: 'pane2', sessionId: 'sess2' }])).toBeNull();
  });
});

describe('visibleTabs', () => {
  const here: readonly ShownConversation[] = [{ paneId: 'pane1' }];
  const away: readonly ShownConversation[] = [{ paneId: 'pane2' }];

  it('puts the preview first and terminals in the order they were opened', () => {
    const tabs = visibleTabs(
      { paneId: 'pane1' },
      [terminal('t1', { paneId: 'pane1' }), terminal('t2', { paneId: 'pane1' })],
      here,
    );
    expect(tabs.map(tabKey)).toEqual(['preview', 'terminal:t1', 'terminal:t2']);
  });

  it('hides everything belonging to a conversation that has left', () => {
    const tabs = visibleTabs({ paneId: 'pane1' }, [terminal('t1', { paneId: 'pane1' })], away);
    expect(tabs).toEqual([]);
  });

  /*
   * The split-view case: two conversations side by side, each with a shell. A
   * pane must never show the other pane's terminal.
   */
  it('shows only the tabs of conversations that are on screen', () => {
    const tabs = visibleTabs(
      null,
      [terminal('mine', { paneId: 'pane1' }), terminal('theirs', { paneId: 'pane2' })],
      here,
    );
    expect(tabs.map(tabKey)).toEqual(['terminal:mine']);
  });
});

/*
 * The "open on its own" appearance option, at the layer where it bites: a tab
 * in an empty strip is what opens the dock, so keeping agent arrivals out of
 * `visibleTabs` is the entire mechanism. What must never be caught in it is
 * anything the user opened themselves — that is the difference between an
 * option that quiets the window and one that loses people's shells.
 */
describe('visibleTabs with the dock forbidden to open on its own', () => {
  const here: readonly ShownConversation[] = [{ paneId: 'pane1' }];
  const busy: readonly ShownConversation[] = [{ paneId: 'pane1', hasTasks: true }];

  function browser(id: string, agentOpened: boolean): BrowserRecord {
    return {
      info: {
        id,
        openedAt: 0,
        state: { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false },
      },
      owner: { paneId: 'pane1' },
      ...(agentOpened ? { agentOpened: true } : {}),
    } as BrowserRecord;
  }

  it('keeps the tasks tab out of the strip', () => {
    expect(visibleTabs(null, [], busy, [], null, [], false)).toEqual([]);
    // And the flag defaulting to true is every release before it: same state,
    // tab present.
    expect(visibleTabs(null, [], busy).map(tabKey)).toEqual(['tasks:pane1']);
  });

  it('keeps an agent-opened page out, and leaves the user’s own alone', () => {
    const tabs = visibleTabs(
      null,
      [],
      here,
      [],
      null,
      [browser('mine', false), browser('theirs', true)],
      false,
    );
    expect(tabs.map(tabKey)).toEqual(['browser:mine']);
  });

  it('reveals what arrived while it was off, the moment it is back on', () => {
    const records = [browser('hidden', true)];
    expect(visibleTabs(null, [], busy, [], null, records, false)).toEqual([]);
    // Same records, same conversations — only the permission changed. This is
    // `setDockAutoOpen`'s reveal: nothing was destroyed by being suppressed.
    expect(visibleTabs(null, [], busy, [], null, records, true).map(tabKey)).toEqual([
      'browser:hidden',
      'tasks:pane1',
    ]);
  });

  it('touches nothing the user opened: preview, file, shells, agent tabs', () => {
    const tabs = visibleTabs(
      { paneId: 'pane1' },
      [terminal('t1', { paneId: 'pane1' })],
      here,
      [{ paneId: 'pane1', taskId: 'task9' }],
      { paneId: 'pane1' },
      [],
      false,
    );
    expect(tabs.map(tabKey)).toEqual(['preview', 'file', 'terminal:t1', 'agent:pane1:task9']);
  });
});

describe('nextActiveTab', () => {
  const strip = [PREVIEW_TAB, term('a'), term('b'), term('c')];

  it('leaves a still-visible tab alone', () => {
    expect(nextActiveTab(term('b'), strip, strip)).toEqual(term('b'));
  });

  /*
   * Chrome's rule, and `closePane`'s: the eye is already where the closed tab
   * was, so the neighbour to its left is the least disorienting place to land.
   */
  it('falls to the neighbour on the left when its tab goes', () => {
    const after = [PREVIEW_TAB, term('a'), term('c')];
    expect(nextActiveTab(term('b'), after, strip)).toEqual(term('a'));
  });

  it('keeps walking left past tabs that also went', () => {
    const after = [PREVIEW_TAB, term('c')];
    expect(nextActiveTab(term('b'), after, strip)).toEqual(PREVIEW_TAB);
  });

  it('takes the first tab when the one that went was leftmost', () => {
    const after = [term('a'), term('b'), term('c')];
    expect(nextActiveTab(PREVIEW_TAB, after, strip)).toEqual(term('a'));
  });

  it('is null when the strip is empty, and adopts a tab when it was', () => {
    expect(nextActiveTab(term('a'), [], strip)).toBeNull();
    expect(nextActiveTab(null, [PREVIEW_TAB], [])).toEqual(PREVIEW_TAB);
  });
});
