/**
 * @vitest-environment jsdom
 *
 * Where a conversation opens, and when the transcript stops following its tail.
 *
 * Two defects, one symptom — "I reload a session and land way up in the old
 * conversation, and have to scroll all the way down":
 *
 *  - **The pin outlived the conversation.** `pinned` is a ref on a component
 *    mounted once per column and never keyed on the session, so scrolling up to
 *    read something (which unpins) meant the *next* session opened in that
 *    column did not follow its tail either — and the viewport kept the old
 *    offset, which is the "partway up" part.
 *  - **The follower unpinned itself mid-load.** The handler unpinned whenever
 *    the viewport was not at the bottom, and each `scrollTop` assignment queues
 *    a scroll event handled after further rows may have grown the box. History
 *    arriving in bulk is exactly that, so the load unpinned the follower it was
 *    relying on, and nothing pinned it again.
 *
 * jsdom does no layout: `scrollHeight` and `clientHeight` are 0 and assigning
 * `scrollTop` is inert. So the geometry is stubbed on the viewport element and
 * scroll events are dispatched by hand — which is the honest way to test this
 * anyway, because the browser's own timing (an event queued against a box that
 * has since grown) is precisely what the fix is about.
 */

import type { AgentEvent } from '@rx-artemis/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Transcript } from '@/components/Transcript';
import { TooltipProvider } from '@/components/ui/tooltip';
import { forgetFolds } from '@/lib/foldMemory';
import { useApp } from '@/state/store';
import { appTranscript, seedApp } from '@/state/testkit';

/** The follower observes the content box; the tests drive growth explicitly. */
let resized: (() => void) | null = null;
class CapturingObserver {
  constructor(callback: () => void) {
    resized = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', CapturingObserver);

/** The scrollable viewport the component holds a ref to. */
function viewport(): HTMLElement {
  const el = document.querySelector('.overflow-y-auto');
  if (!(el instanceof HTMLElement)) throw new Error('no scroll viewport rendered');
  return el;
}

/**
 * Give the viewport a layout jsdom will not.
 *
 * `scrollTop` is defined as a real accessor rather than a value so the
 * component's assignments are observable *and* clamped the way a browser
 * clamps them — a follower that assigns `scrollHeight` (not
 * `scrollHeight - clientHeight`) depends on that clamp.
 */
function layout(el: HTMLElement, { height, view }: { height: number; view: number }): void {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: view, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = Math.max(0, Math.min(next, height - view));
    },
  });
}

/** Grow the content box, then let the follower react as the browser would. */
function grow(el: HTMLElement, height: number): void {
  const view = el.clientHeight;
  const top = el.scrollTop;
  layout(el, { height, view });
  el.scrollTop = top;
  act(() => {
    resized?.();
  });
  // A browser fires `scroll` after a programmatic assignment, asynchronously —
  // which is the timing the follower has to survive, so it is reproduced here.
  fireEvent.scroll(el);
}

/**
 * Grow the box and let the follower move, *without* delivering the scroll
 * event that assignment queues.
 *
 * The real window between a programmatic scroll and its event: a browser
 * dispatches it on the next frame, and a reader who reaches for the wheel
 * inside that window scrolls against a follower that has not been told where
 * it just moved to.
 */
function growQuietly(el: HTMLElement, height: number): void {
  const view = el.clientHeight;
  const top = el.scrollTop;
  layout(el, { height, view });
  el.scrollTop = top;
  act(() => {
    resized?.();
  });
}

/** A scroll the user performed, at a given offset. */
function userScrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

function stream(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): AgentEvent[] {
  return drafts.map((draft, index) => ({
    ...draft,
    runId: 'run_1',
    seq: index,
    ts: 1000 + index,
  })) as AgentEvent[];
}

function play(...drafts: Array<Omit<AgentEvent, 'runId' | 'seq' | 'ts'>>): void {
  act(() => {
    for (const event of stream(...drafts)) appTranscript().apply(event);
    appTranscript().flush();
  });
}

function say(text: string): Omit<AgentEvent, 'runId' | 'seq' | 'ts'> {
  return { type: 'text.complete', text } as Omit<AgentEvent, 'runId' | 'seq' | 'ts'>;
}

function open(): void {
  render(
    <TooltipProvider>
      <Transcript />
    </TooltipProvider>,
  );
}

/** Point the column at another conversation, as resuming one does. */
function showConversation(id: string | null): void {
  act(() => {
    seedApp({ resumeSessionId: id as never, run: null });
  });
}

beforeEach(() => {
  forgetFolds();
  resized = null;
  appTranscript().reset();
  appTranscript().flush();
  seedApp({
    run: null,
    permissionQueue: [],
    resumeSessionId: null as never,
    conversationWidth: 'comfortable',
  });
});

afterEach(() => {
  cleanup();
  useApp.setState({ conversationWidth: 'comfortable' });
});

describe('following the tail', () => {
  it('lands at the end when a session`s history arrives', () => {
    open();
    const el = viewport();
    layout(el, { height: 400, view: 400 });

    // History lands in one burst, the way `loadSessionHistory` applies it.
    play(say('the first thing said'), say('the last thing said'));
    grow(el, 4000);

    expect(el.scrollTop).toBe(3600);
  });

  it('keeps following when its own scroll event lands against a grown box', () => {
    /*
     * The defect, at its exact timing. The follower assigns `scrollTop` for the
     * rows it has; the browser queues a scroll event; more history lands and
     * grows the box; *then* the queued event is handled — now measuring a
     * viewport that is thousands of pixels short of a bottom that moved. The
     * old rule read that as "the reader is not at the bottom" and unpinned the
     * follower mid-load, which is why a reloaded session stopped partway up.
     */
    open();
    const el = viewport();
    layout(el, { height: 400, view: 400 });

    play(say('the first page of history'));
    grow(el, 2000); // follower assigns 1600; scroll event fires at that height

    // The next rows land before the *next* event is handled…
    const top = el.scrollTop;
    layout(el, { height: 6000, view: 400 });
    el.scrollTop = top;
    fireEvent.scroll(el); // …and this is that stale event: 4000px from the end

    // The follower must still be following, so the rows that land now arrive
    // at the bottom rather than four thousand pixels above it.
    act(() => {
      resized?.();
    });
    expect(el.scrollTop).toBe(5600);
  });

  it('lets go for a reader who scrolls up before the follower`s own event lands', () => {
    /*
     * The follower records the offset it assigns rather than waiting to be told
     * by the scroll event it queued. Without that, a wheel-up inside the window
     * before that event arrives compares against a stale offset, reads as
     * downward movement, and the reader is dragged back to the bottom by the
     * next rows to land.
     */
    open();
    const el = viewport();
    layout(el, { height: 400, view: 400 });
    play(say('history'));
    growQuietly(el, 4000);
    expect(el.scrollTop).toBe(3600);

    userScrollTo(el, 1000);

    play(say('more arriving'));
    grow(el, 5000);
    expect(el.scrollTop).toBe(1000);
  });

  it('stops following when the reader scrolls up, and says so', () => {
    open();
    const el = viewport();
    layout(el, { height: 4000, view: 400 });
    play(say('something to read'));
    grow(el, 4000);

    userScrollTo(el, 1200);
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeTruthy();

    // …and new rows no longer drag the reader away from what they are reading.
    play(say('and another'));
    grow(el, 5000);
    expect(el.scrollTop).toBe(1200);
  });

  it('follows again once the reader returns to the bottom', () => {
    open();
    const el = viewport();
    layout(el, { height: 4000, view: 400 });
    play(say('something to read'));
    grow(el, 4000);

    userScrollTo(el, 1200);
    userScrollTo(el, 3600);

    play(say('and another'));
    grow(el, 5000);
    expect(el.scrollTop).toBe(4600);
  });
});

describe('opening another conversation', () => {
  it('starts at the end even when the last one was left scrolled up', () => {
    // The reported bug, whole: read something (unpins), open another session,
    // and the column inherited both the pin and the offset.
    open();
    const el = viewport();
    layout(el, { height: 4000, view: 400 });
    play(say('an older conversation'));
    grow(el, 4000);
    userScrollTo(el, 900);

    showConversation('sess-next');
    act(() => {
      appTranscript().reset();
      appTranscript().flush();
    });
    play(say('the conversation just opened'));
    grow(el, 3000);

    expect(el.scrollTop).toBe(2600);
  });

  it('clears the jump-to-end affordance with the conversation it belonged to', () => {
    open();
    const el = viewport();
    layout(el, { height: 4000, view: 400 });
    play(say('an older conversation'));
    grow(el, 4000);
    userScrollTo(el, 900);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeTruthy();

    showConversation('sess-next');

    expect(screen.queryByRole('button', { name: /jump to latest/i })).toBeNull();
  });
});
