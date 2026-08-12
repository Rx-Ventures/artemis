/**
 * Streaming assistant text, revealed a word at a time.
 * ============================================================================
 *
 * WHAT THIS FIXES. The transcript model coalesces deltas to one flush per
 * animation frame, so a provider mid-sentence hands the pane whatever arrived
 * in the last 16ms and it lands as a block — half a clause, at full opacity,
 * instantly. That is the "pop": not that text is fast, but that it arrives in
 * ragged rectangles with no gesture between "absent" and "there".
 *
 * So this splits the incoming text into words and fades each one in. Two rules
 * shape everything below, and they pull against each other:
 *
 *  1. **The reveal must never become the bottleneck.** A typewriter that drips
 *     at a fixed rate is a lie about how fast the model answered, and on a fast
 *     provider it falls minutes behind. Whatever is waiting has to be on screen
 *     within {@link DRAIN_MS}, however much of it there is.
 *  2. **The DOM cost is per *new* word, never per word on screen.** A word that
 *     has finished animating is merged back into one plain text node, so a
 *     20,000-word answer is one text node and a handful of live spans — not
 *     20,000 spans that React reconciles on every frame.
 *
 * Rule 2 is the transcript's performance contract (`Transcript.tsx`, rules 1–4)
 * restated for the inside of a block: the pane made a token cost one leaf
 * re-render, and it would all be for nothing if that leaf then rebuilt a span
 * per word of everything it had ever said.
 *
 * ============================================================================
 * HOW THE PACING WORKS
 *
 * When words start waiting, the backlog is divided by the number of frames in
 * the drain window and that many go out per frame until the queue is empty. The
 * behaviour falls out of the arithmetic rather than being special-cased:
 *
 *  - a slow provider has one word waiting, so one word goes out, and the fade
 *    is the whole effect;
 *  - a fast one has ten waiting, so it releases one a frame while more arrive,
 *    and the fades overlap into a wave;
 *  - a burst dumps two hundred, so it releases ~15 a frame — visibly a cascade
 *    rather than a block, and gone in a fifth of a second either way.
 *
 * Past {@link INSTANT_WORDS} the animation is dropped entirely. At that size
 * the arrival is not a sentence being spoken, it is a wall of text landing —
 * usually a non-streaming provider's whole message or a resumed run — and
 * cascading it would be an effect for its own sake, on the one path where the
 * cost is real.
 *
 * ============================================================================
 * IT RUNS ONCE, ON TEXT THAT IS ACTUALLY ARRIVING
 *
 * The fade means "this word is being written". Text that was written before
 * anyone was looking at it is not arriving, so a mount adopts whatever it is
 * handed and animates only what comes after — see `adopted` below.
 *
 * Without that, every remount replays the fade over words the reader has
 * already read: switching sessions and back mid-run, or any future change that
 * unmounts a row (virtualised scrolling being the obvious one), would flash the
 * whole answer. A finished block never mounts this at all — it renders as
 * markdown — so the ordinary re-read of an old turn was never at risk; the live
 * ones were.
 *
 * ============================================================================
 * WHY A HALF-WORD IS HELD BACK
 *
 * Deltas do not respect word boundaries: "Hello wor" then "ld." is normal. Only
 * text with whitespace after it is eligible to be revealed, so the trailing
 * fragment waits for the space that ends it. Otherwise "wor" fades in and then
 * silently grows an "ld." — an animation playing on something that is not yet a
 * word, which is exactly the ragged edge this file exists to remove.
 *
 * The cost is that the reveal trails the true text by up to one word. Nothing
 * on screen shows that, because prose that stops at a word boundary looks like
 * prose that stopped. The only case it would show is a fragment that never gets
 * its space — a very long unbroken token, or a stream that stalls mid-word —
 * so {@link MAX_HELD} releases anything that overruns, and a completed block
 * re-renders as markdown from the authoritative text regardless.
 */

import {
  memo,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { useApp } from '../state/store';
import { cn } from '@/lib/utils';

/**
 * How long a single word's fade runs. Must match `artemis-word-in` in
 * `index.css` — this side only uses it to know when a word is finished and can
 * be merged back into the settled text.
 */
const WORD_MS = 150;

/**
 * How long the whole backlog gets to reach the screen.
 *
 * The ceiling on how far the reveal may trail the model. A backlog is divided
 * by the number of frames in this window *once* and released at that flat rate,
 * so it is genuinely empty when the window ends — dividing the remainder every
 * frame instead would be an exponential decay that never quite arrives.
 *
 * Tuned by eye against a simulated provider, and landed fast: at 200ms the
 * cascade is legible *as* a cascade, which is a hair slower than it wants to
 * be. The gesture should register without the reader ever waiting on it.
 */
const DRAIN_MS = 115;

/** One frame at 60Hz, for turning the drain window into a release rate. */
const FRAME_MS = 16.7;

/**
 * Backlog past which words are shown at once, with no fade.
 *
 * Sized above any plausible frame of *streamed* prose — a fast provider is tens
 * of words per frame, not hundreds — so in practice this only catches whole
 * messages arriving as one delta.
 */
const INSTANT_WORDS = 220;

/** Spacing between words released together, so a burst cascades. */
const STAGGER_MS = 14;

/** Ceiling on a batch's total stagger, so a big release still lands promptly. */
const STAGGER_BUDGET_MS = 90;

/** A held-back fragment this long is released without waiting for whitespace. */
const MAX_HELD = 64;

/** {@link WORD_MS} on its way to `.word-in`. Hoisted so it is one object. */
const WORD_MS_VAR = { '--word-ms': `${WORD_MS}ms` } as CSSProperties;

/**
 * One frame's release: the words that started fading together.
 *
 * Batched rather than tracked per word because the whole batch retires at once,
 * which keeps the live-span bookkeeping to a couple of array entries instead of
 * a timestamp per word.
 */
interface Batch {
  /** Render key. Monotonic, never reused, so React cannot restart a fade. */
  readonly key: number;
  readonly words: readonly string[];
  /** Per-word animation offset, in ms. */
  readonly stagger: number;
  /** Timestamp past which every word in the batch has finished. */
  readonly done: number;
}

/**
 * Words plus the whitespace that follows them, so `join('')` is lossless.
 *
 * The leading `\s*` matters as much as the trailing one: it is what carries a
 * paragraph break onto the front of the word after it, instead of dropping the
 * blank line on the floor.
 */
const WORD_PATTERN = /\s*\S+\s*/g;

/**
 * Index up to which `text` holds complete words — the start of the trailing
 * fragment, or the end if the text ends in whitespace.
 *
 * Scans back from the end rather than forward from `from`, so the work is the
 * length of the fragment (a few characters) and not the length of the backlog.
 */
function completeThrough(text: string, from: number): number {
  for (let i = text.length - 1; i >= from; i--) {
    const code = text.charCodeAt(i);
    // Space, tab, newline, carriage return, form feed, vertical tab.
    if (code === 32 || (code >= 9 && code <= 13)) return i + 1;
  }
  return from;
}

function splitWords(chunk: string): string[] {
  WORD_PATTERN.lastIndex = 0;
  return chunk.match(WORD_PATTERN) ?? [];
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Renders `text` as it arrives, fading in each new word.
 *
 * Streaming blocks only. A finished block renders as markdown from the same
 * text and never mounts this, which is also why nothing here tries to animate
 * its way to a final state: the swap is the end of the animation.
 *
 * Renders the text and nothing else when `streamingWordFade` is off — see the
 * switch in Appearance. Off is the plain node the pane had before any of this,
 * not a faster version of it.
 */
export const StreamingText = memo(function StreamingText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}): ReactElement {
  // React state would put a `setState` on the per-token path for data that is
  // only ever read while painting. One counter drives the re-render; everything
  // else is a ref, mutated from the frame callback.
  const [, render] = useReducer((n: number) => n + 1, 0);

  // Subscribed here rather than in the row: this component exists only for a
  // block that is *currently* streaming, of which there is normally one, so the
  // preference costs one subscription for the whole pane instead of one per
  // assistant turn in the history.
  const enabled = useApp((s) => s.streamingWordFade);

  // Written in the effect rather than during render: the frame callback is the
  // only reader, it always runs after the effect that follows a delta, and a
  // ref assigned during render is a bailout under the React Compiler.
  const textRef = useRef(text);

  // Whatever is on screen the moment this mounts was written before anyone was
  // looking at it — a session switched back to mid-run, a row remounted — so it
  // is adopted whole and only what arrives after it animates. The fade means
  // "this is arriving"; replaying it over words the reader has already read is
  // both untrue and, on every remount of a long turn, the pane flashing.
  //
  // A state initialiser rather than a ref written on the first render: this has
  // to be in place for the first *paint*, and an effect that fixed it up
  // afterwards would blank the block for a frame.
  const [adopted] = useState(() => {
    const through = completeThrough(text, 0);
    // The trailing fragment is deliberately not adopted, so the word it becomes
    // still fades in as a word once its space arrives.
    return { settled: text.slice(0, through), parsed: through };
  });

  /** Text whose fade is over. One node, however long the answer gets. */
  const settled = useRef(adopted.settled);
  /** Words released this frame or recently, still fading. */
  const live = useRef<readonly Batch[]>([]);
  /** Tokenised but not yet released, with `head` as the read cursor. */
  const queue = useRef<string[]>([]);
  const head = useRef(0);
  /** How much of `text` has been tokenised, so no character is scanned twice. */
  const parsed = useRef(adopted.parsed);
  const seq = useRef(0);
  const frame = useRef(0);
  /** Words released per frame. Held across a backlog — see {@link DRAIN_MS}. */
  const rate = useRef(0);

  useEffect(() => {
    textRef.current = text;
    const source = text;

    // Switched off — including mid-block. Adopt everything so that switching it
    // back on continues from here rather than replaying the turn so far, and
    // schedule nothing: with no frame loop and no live batches this costs the
    // same as rendering the string, which is what it now does.
    if (!enabled) {
      settled.current = source;
      live.current = [];
      queue.current = [];
      head.current = 0;
      rate.current = 0;
      parsed.current = source.length;
      return;
    }

    // A text shorter than what has already been consumed means the block was
    // rewritten under us — a re-run reusing the id. Splicing the two together
    // would be worse than starting again, and starting again *adopts* rather
    // than replays, for the same reason the mount does: the reader did not
    // watch this arrive.
    if (source.length < parsed.current) {
      const through = completeThrough(source, 0);
      settled.current = source.slice(0, through);
      live.current = [];
      queue.current = [];
      head.current = 0;
      rate.current = 0;
      parsed.current = through;
      render();
    }

    const pendingWords = queue.current.length - head.current;
    const hasWork = pendingWords > 0 || live.current.length > 0 || parsed.current < source.length;
    if (!hasWork || frame.current !== 0) return;

    const tick = (now: number): void => {
      frame.current = 0;
      const current = textRef.current;
      let changed = false;

      // 1. Retire finished batches into the settled prefix. They are in start
      //    order and share a duration, so the finished ones are always a prefix.
      const batches = live.current;
      let retired = 0;
      let finished = '';
      for (const batch of batches) {
        if (now < batch.done) break;
        finished += batch.words.join('');
        retired++;
      }
      if (retired > 0) {
        settled.current += finished;
        live.current = batches.slice(retired);
        changed = true;
      }

      // 2. Tokenise only what has arrived since the last frame.
      const through = completeThrough(current, parsed.current);
      if (through > parsed.current) {
        const words = splitWords(current.slice(parsed.current, through));
        if (words.length > 0) queue.current.push(...words);
        parsed.current = through;
      } else if (current.length - parsed.current > MAX_HELD) {
        // A fragment that has outgrown any real word — a URL, a base64 blob, a
        // stalled stream. Release it rather than leave the pane looking stuck.
        queue.current.push(current.slice(parsed.current));
        parsed.current = current.length;
      }

      // 3. Release this frame's share of whatever is waiting.
      const waiting = queue.current.length - head.current;
      if (waiting > 0) {
        if (waiting >= INSTANT_WORDS || prefersReducedMotion()) {
          settled.current += queue.current.slice(head.current).join('');
          head.current = queue.current.length;
        } else {
          // The rate only ever ratchets up within a backlog. Recomputing it
          // from what is left each frame would make the release proportional to
          // the remainder — a decay that empties 90% of a burst quickly and
          // then dribbles the tail out for a second, which is precisely the lag
          // this is supposed to bound.
          const drainFrames = Math.max(1, Math.round(DRAIN_MS / FRAME_MS));
          rate.current = Math.max(rate.current, Math.ceil(waiting / drainFrames));
          const count = Math.min(waiting, rate.current);
          const words = queue.current.slice(head.current, head.current + count);
          head.current += count;
          const stagger = count > 1 ? Math.min(STAGGER_MS, STAGGER_BUDGET_MS / count) : 0;
          live.current = [
            ...live.current,
            {
              key: seq.current++,
              words,
              stagger,
              done: now + WORD_MS + stagger * (count - 1),
            },
          ];
        }
        changed = true;
      }

      // Drained: drop the consumed tokens so the array cannot grow with the
      // answer. Only when empty, so this is never a mid-stream O(n) splice.
      if (head.current > 0 && head.current === queue.current.length) {
        queue.current = [];
        head.current = 0;
        // Nothing is waiting, so the next backlog sizes its own rate. A rate
        // held past the burst that earned it would skip the fade on the single
        // word that follows a pause.
        rate.current = 0;
      }

      // A render re-runs this effect, which schedules the next frame if there
      // is still anything to do. If nothing changed there is nothing left to
      // wait for either, and the loop stops until the next delta arrives.
      if (changed) render();
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== 0) {
        cancelAnimationFrame(frame.current);
        frame.current = 0;
      }
    };
  });

  // Switched off, this is the plain node the pane rendered before any of the
  // above existed. `text` rather than `settled.current` because the effect that
  // adopts it has not run yet on the render that follows a delta — reading the
  // ref here would paint one frame behind the model.
  if (!enabled) return <div className={cn('caret', className)}>{text}</div>;

  return (
    <div
      className={cn('caret', className)}
      // The fade runs in CSS but its *end* has to be known here, to fold a
      // finished word back into the settled text. Rather than the same duration
      // written in two files with a comment begging the next person to keep
      // them in step, the constant is the source and the rule reads it — the
      // literal in `index.css` is only a fallback.
      style={WORD_MS_VAR}
    >
      {settled.current}
      {live.current.map((batch) => (
        <Released key={batch.key} words={batch.words} stagger={batch.stagger} />
      ))}
    </div>
  );
});

/**
 * One frame's words, mid-fade.
 *
 * `memo` is what makes rule 2 hold at the React level: a batch's props never
 * change after it is created, so the frames between its release and its
 * retirement re-render nothing but the wrapper. Only the newest batch and the
 * settled text actually do work.
 */
const Released = memo(function Released({
  words,
  stagger,
}: {
  readonly words: readonly string[];
  readonly stagger: number;
}): ReactElement {
  return (
    <>
      {words.map((word, index) => (
        <span
          // Positional keys are correct here and only here: a batch's word list
          // is frozen at creation, so there is no reorder for a key to guard.
          key={index}
          className="word-in"
          style={stagger > 0 ? { animationDelay: `${index * stagger}ms` } : undefined}
        >
          {word}
        </span>
      ))}
    </>
  );
});
