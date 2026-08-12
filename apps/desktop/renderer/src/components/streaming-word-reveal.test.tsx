/**
 * @vitest-environment jsdom
 *
 * How streamed text reaches the screen.
 *
 * The reveal is the kind of thing that looks right in a demo and is wrong in
 * use, so the four ways it can be wrong are asserted rather than watched:
 *
 *  - **It drops or reorders text.** The animation is a rendering detail; the
 *    words are the product. Whatever the pacing does, concatenating what is on
 *    screen must equal what the model sent.
 *  - **It falls behind.** A fixed rate looks fine on a slow provider and turns
 *    a fast one into a progress bar. A backlog has to be on screen in a fixed
 *    *time*, which means the per-frame release scales with what is waiting.
 *  - **It animates a half-word.** Deltas break mid-word, and fading in "wor"
 *    before "ld." arrives is the ragged edge this exists to remove.
 *  - **It keeps a span per word.** The transcript's whole performance contract
 *    is that a token costs one leaf; it would be undone by a leaf that rebuilds
 *    an element for every word it has ever rendered.
 *  - **It replays.** The fade says "this is arriving". Text that was already
 *    written before anyone looked at it is not arriving, so coming back to a
 *    live session — or anything else that remounts the row — must not run it
 *    again over words the reader has already read.
 *
 * Frames are driven by hand. `requestAnimationFrame` is stubbed with a queue
 * and a clock the test advances, so "one frame later" is exact instead of a
 * timeout that passes on a fast machine and flakes on a loaded one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { StreamingText } from '@/components/StreamingText';
import { useApp } from '@/state/store';

/** Frame length used by the clock. Nothing in the component depends on it. */
const FRAME_MS = 16;

let clock = 0;
let queued: Array<(now: number) => void> = [];
let nextHandle = 1;

/** Run every frame scheduled so far, then any they scheduled in turn. */
function frames(count: number): void {
  for (let i = 0; i < count; i++) {
    clock += FRAME_MS;
    const due = queued;
    queued = [];
    act(() => {
      for (const callback of due) callback(clock);
    });
  }
}

beforeEach(() => {
  clock = 0;
  queued = [];
  nextHandle = 1;
  useApp.setState({ streamingWordFade: true });
  vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
    queued.push(callback);
    return nextHandle++;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A sentence's worth of words, so counts are easy to reason about. */
function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${i}`).join(' ') + ' ';
}

describe('streaming text reveal', () => {
  it('releases a slow stream one word at a time', () => {
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text="The quick brown fox " />);

    frames(1);
    expect(container.textContent).toBe('The ');

    frames(1);
    expect(container.textContent).toBe('The quick ');

    frames(2);
    expect(container.textContent).toBe('The quick brown fox ');
  });

  it('fades each newly released word', () => {
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text="alpha beta " />);
    frames(1);

    const live = container.querySelectorAll('.word-in');
    expect(live).toHaveLength(1);
    expect(live[0]?.textContent).toBe('alpha ');
  });

  it('keeps up with a burst by releasing more per frame', () => {
    // Sixty words waiting is a fast provider mid-answer, not a paste. A fixed
    // one-per-frame rate would need sixty frames — a second of visible lag that
    // grows for as long as the model keeps talking.
    const text = words(60);
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text={text} />);

    frames(7);
    expect(container.textContent).toBe(text);
  });

  it('shows a whole message at once instead of cascading it', () => {
    // What a non-streaming provider produces mid-run: not a sentence arriving,
    // a wall of text landing. Animating it is cost with no gesture.
    const text = words(400);
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text={text} />);

    frames(1);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);
  });

  it('holds back a word the provider has not finished sending', () => {
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text="Hello wor" />);
    frames(4);
    expect(container.textContent).toBe('Hello ');

    rerender(<StreamingText text="Hello world. " />);
    frames(2);
    expect(container.textContent).toBe('Hello world. ');
  });

  it('releases a fragment that has outgrown any real word', () => {
    // A URL, a base64 blob, a stream that stalled mid-token. Waiting for a
    // space that may never come would leave the pane looking hung.
    const long = `x${'y'.repeat(80)}`;
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text={long} />);

    frames(2);
    expect(container.textContent).toBe(long);
  });

  it('adopts the text already on screen when it mounts', () => {
    // Coming back to a session that is still streaming, or any other remount.
    // Those words were read a minute ago; fading them in says they just
    // arrived, which is both a lie and a distraction.
    const { container } = render(<StreamingText text="Already written and read. " />);

    expect(container.textContent).toBe('Already written and read. ');
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);

    frames(4);
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);
  });

  it('still animates what arrives after a remount', () => {
    // The other half of the rule: adopting the past must not switch the
    // animation off for the rest of the turn.
    const { container, rerender } = render(<StreamingText text="Read already. " />);
    frames(2);
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);

    rerender(<StreamingText text="Read already. New words " />);
    frames(1);
    expect(container.querySelectorAll('.word-in')).toHaveLength(1);
    expect(container.textContent).toBe('Read already. New ');
  });

  it('adopts rather than replays when the block is rewritten under it', () => {
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text="first attempt at an answer " />);
    frames(8);
    expect(container.textContent).toBe('first attempt at an answer ');

    rerender(<StreamingText text="second try " />);
    frames(1);
    expect(container.textContent).toBe('second try ');
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);
  });

  it('loses nothing across a stream that arrives in ragged chunks', () => {
    const chunks = ['Rendering ', 'the tra', 'nscript ', 'is\n\nthe ', 'hot path', '. Always.'];
    let sent = '';
    const { container, rerender } = render(<StreamingText text="" />);
    frames(1);

    for (const chunk of chunks) {
      sent += chunk;
      rerender(<StreamingText text={sent} />);
      frames(3);
    }
    // The last token has no whitespace after it, so it is still held — which is
    // the point of the previous test, and why this asserts on the prefix.
    frames(20);
    expect(sent.startsWith(container.textContent ?? '')).toBe(true);
    expect(container.textContent).toBe('Rendering the transcript is\n\nthe hot path. ');
  });

  it('is off when the appearance switch is off', () => {
    // Off must mean *gone*, not "faster": no pacing, no per-word elements, the
    // delta on screen the frame it arrives. A setting that only turned the
    // animation down would be the same complaint with extra steps.
    useApp.setState({ streamingWordFade: false });
    const { container, rerender } = render(<StreamingText text="" />);

    rerender(<StreamingText text="Everything at once, immediately. " />);
    expect(container.textContent).toBe('Everything at once, immediately. ');
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);

    frames(4);
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);
  });

  it('takes the switch mid-block without replaying the turn', () => {
    const { container, rerender } = render(<StreamingText text="" />);
    rerender(<StreamingText text="fading along nicely " />);
    frames(4);
    expect(container.textContent).toBe('fading along nicely ');

    useApp.setState({ streamingWordFade: false });
    rerender(<StreamingText text="fading along nicely and now plainly " />);
    expect(container.textContent).toBe('fading along nicely and now plainly ');
    expect(container.querySelectorAll('.word-in')).toHaveLength(0);

    // Back on: the words already read stay put, and only the next ones fade.
    useApp.setState({ streamingWordFade: true });
    rerender(<StreamingText text="fading along nicely and now plainly again " />);
    frames(1);
    expect(container.textContent).toBe('fading along nicely and now plainly again ');
    expect(container.querySelectorAll('.word-in')).toHaveLength(1);
  });

  it('merges finished words back into a single node', () => {
    // The load-bearing assertion. A span per word would satisfy every test
    // above and quietly make a long answer O(words) to re-render per frame.
    const text = words(300);
    let sent = '';
    const { container, rerender } = render(<StreamingText text="" />);

    let peak = 0;
    for (let i = 0; i < 300; i++) {
      sent += `w${i} `;
      rerender(<StreamingText text={sent} />);
      frames(1);
      peak = Math.max(peak, container.querySelectorAll('.word-in').length);
    }
    frames(20);

    expect(container.textContent).toBe(text);
    expect(peak).toBeLessThan(40);
  });
});
