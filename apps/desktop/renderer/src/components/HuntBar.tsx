/**
 * The hunt bar: Artemis' bow, her arrow, and the stingray she is after —
 * riding the tail of the conversation.
 * ============================================================================
 *
 * The app is named for the goddess of the hunt, and this is the one place it
 * says so: a small bow at the left of a one-line scene, a stingray idling at
 * the right, and — for as long as a run is going — an arrow loosed across the
 * width of the text toward it. The quarry being a *stingray* is not mythology,
 * it is the commission; Artemis hunts what she is asked to hunt.
 *
 * ## Inline with the text, third placement of three
 *
 * This strip has lived in two other homes, each rejected by use:
 *
 *  - **In the composer's seam** it read as chrome about the *input*, and the
 *    hairline runbar was the thing that belonged there (it is back there now).
 *  - **Between the scroller and the composer** it was always on screen, but
 *    that is exactly what was wrong with it: it sat fixed under a conversation
 *    that scrolls, belonging to neither the text nor the input.
 *
 * It renders *inside the transcript's content column*, after the last row —
 * the `Working` indicator's neighbourhood. That is what "pinned to the bottom
 * of the text" turns out to mean: it rides the conversation's tail, pushed
 * down by each row that streams in, scrolling away with the text when the
 * reader scrolls up and coming back with the tail-follower. It shares the
 * column's width and margins, so the scene plays out exactly across the
 * measure of the prose above it.
 *
 * One rule inherited from the scroller: the strip's height never animates.
 * The tail-follower is a `ResizeObserver` on this very content box, and a
 * scene that breathed vertically would have it recomputing `scrollTop` for as
 * long as the run lived. Every motion here is transform and opacity.
 *
 * ## The scene's states are the run's own, nothing invented
 *
 *  - **firing** (`starting` / `running`): draw, hold, loose; the arrow
 *    crosses to the stingray, which swims in place all cycle and flinches as
 *    the arrow arrives — then the bow re-nocks and the hunt resumes. A run in
 *    progress is a hunt that has not landed yet.
 *  - **holding** (`awaiting_permission`): drawn and dead still, the ray
 *    frozen mid-swim. Everyone is waiting on you.
 *  - **rest** (before the first run, and after `ended`): string straight,
 *    arrow gone, both figures dimmed to faint ink. The animation stopping —
 *    not the scene vanishing — is what says "complete".
 *
 * ## Moonlight, not machine-cyan
 *
 * The whole scene draws in `lunar` while anything is happening and `ink-faint`
 * at rest. The tone system (cyan for work, amber for approvals) grades rows —
 * badges, dots, labels — and this is not a row, it is the app's own mark;
 * `lunar` is the accent named for Artemis' light and the colour the runbar
 * sweeps in, and the two reading as one system matters more than the scene
 * joining a taxonomy it is not part of.
 *
 * ## All CSS, no clock
 *
 * Five animations (see `index.css`, `artemis-bow-*`) share one 2400ms
 * duration and are synchronised by mounting in the same commit — the keyframe
 * percentages are the whole choreography, including the hit: the flight ends
 * at `calc(100% - 40px)` (the ray's flank, however wide the column is) in the
 * same frames the quarry's flinch begins. Nothing here ticks or measures; the
 * single subscription is `run?.status`.
 *
 * `aria-hidden`, whole strip: the status line already reports this state as
 * text, and a screen reader announcing an archery loop would be noise on top.
 */

import type { ReactElement } from 'react';

import { usePane } from '../state/paneContext';
import { cn } from '@/lib/utils';

type Pose = 'firing' | 'holding' | 'rest';

/** String at rest and at full draw. Same M-L-L structure, so the CSS `d`
 * morph between them is legal; the midpoint is where the arrow nocks. */
const STRING_REST = 'M5 2 L5 8 L5 14';
const STRING_DRAWN = 'M5 2 L2 8 L5 14';

export function HuntBar(): ReactElement {
  const status = usePane((s) => s.run?.status ?? null);

  // No run yet reads as `rest`, deliberately — the scene is constant, and a
  // fresh pane's quiet bow is the same statement as a finished run's: nothing
  // is in flight here.
  const pose: Pose =
    status === 'starting' || status === 'running'
      ? 'firing'
      : status === 'awaiting_permission'
        ? 'holding'
        : 'rest';

  return (
    <div
      data-slot="hunt-bar"
      data-pose={pose}
      aria-hidden="true"
      className="relative h-4 shrink-0 overflow-hidden"
    >
      {/*
        The arrow in flight. A span the width of the whole strip with the glyph
        at its left edge, translated by percentages of itself — see the flight
        keyframes for why that is the only way to cross an unmeasured column.
        `opacity-0` in the markup is load-bearing: it is the element's state
        whenever its animation is not running, which is what keeps a loose
        arrow from parking over the bow under `prefers-reduced-motion`.
        Mounted only while firing, so the other poses hold no invisible DOM.
      */}
      {pose === 'firing' ? (
        <span className="hunt-flight absolute inset-0 text-lunar opacity-0">
          <ArrowInFlight />
        </span>
      ) : null}
      <Bow pose={pose} />
      <Stingray pose={pose} />
    </div>
  );
}

/**
 * The bow, facing down-range: string on the left where the archer is, stave
 * bellying right, arrow nocked at the string's midpoint. 16×16 user units
 * rendered at 16px, so the CSS pixel transforms in the keyframes move exactly
 * the user units the paths are drawn in.
 *
 * The firing classes and the static poses are exclusive on purpose. `holding`
 * writes the drawn string and the pulled-back arrow as attributes with no
 * animation to fight; `firing` leaves the attributes at rest and lets the
 * keyframes own the motion. One source of truth per pose, never both.
 */
function Bow({ pose }: { readonly pose: Pose }): ReactElement {
  const firing = pose === 'firing';
  const holding = pose === 'holding';

  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(
        'absolute top-0 left-1 size-4',
        // Lunar while anything is happening; faint ink at rest. A constant
        // fixture has to earn its permanence by being quiet when idle, and
        // has room to be the accent when it is the thing reporting.
        pose === 'rest' ? 'text-ink-faint' : 'text-lunar',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className={firing ? 'hunt-recoil' : undefined}>
        {/* The stave: a shallow arc, drawn heavier than the string so the two
            read as limb and wire rather than as one closed outline — at a
            deeper arc and a single weight the whole bow read as a leaf. It
            never moves relative to the archer; the recoil kicks the group. */}
        <path strokeWidth="1.5" d="M5 2 Q 9.5 8 5 14" />
        <path
          strokeWidth="0.8"
          className={firing ? 'hunt-string' : undefined}
          d={holding ? STRING_DRAWN : STRING_REST}
        />
        {/* The nocked arrow: shaft and head only — fletch ticks at this size
            read as a second head and turn the arrow into ⟷. Gone at rest: it
            was loosed (or never drawn), and a nocked arrow under a finished
            answer would claim work is still coming. */}
        {pose === 'rest' ? null : (
          <g
            className={cn(firing && 'hunt-nock')}
            style={holding ? { transform: 'translateX(-3px)' } : undefined}
          >
            <path d="M5 8 L14 8" />
            <path d="M12 6.2 L14 8 L12 9.8" />
          </g>
        )}
      </g>
    </svg>
  );
}

/**
 * The quarry: a stingray at the far edge, facing the archer.
 *
 * A filled diamond rather than an outline — at 16px a stroked ray reads as a
 * kite — with the whip tail and its barb doing the species work: the barb is
 * the one mark that says *stingray* rather than fish. It swims in place while
 * the hunt is on (`hunt-quarry` is the same 2400ms clock as everything else,
 * with the flinch keyed to the frames the flight ends in), holds still while
 * a permission does, and dims with the bow at rest — unbothered, alive, and
 * plainly never actually struck, because the hunt is the run and the run
 * always comes back for another pass.
 */
function Stingray({ pose }: { readonly pose: Pose }): ReactElement {
  return (
    <svg
      data-part="quarry"
      viewBox="0 0 24 16"
      className={cn(
        'absolute top-0 right-1 h-4 w-6',
        pose === 'rest' ? 'text-ink-faint' : 'text-lunar',
      )}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className={pose === 'firing' ? 'hunt-quarry' : undefined}>
        {/* The disc: snout left toward the incoming arrow, wings swept back to
            points. Filled, because at 16px a stroked ray reads as a kite. */}
        <path
          fill="currentColor"
          stroke="none"
          d="M1.8 8 C 4 5.6 7 3.3 10.5 2.7 C 11.4 4.8 12.2 6 13 7 Q 14 7.6 14 8 Q 14 8.4 13 9 C 12.2 10 11.4 11.2 10.5 13.3 C 7 12.7 4 10.4 1.8 8 Z"
        />
        {/* The whip tail, and the barb that makes it a stingray. */}
        <path strokeWidth="0.9" d="M14 8 C 16.5 8.15 18.5 9.3 22 12.8" />
        <path strokeWidth="0.9" d="M18 9.35 L 19.3 8.15" />
        {/* Eyes, punched in the window's own background so they read as cut
            through the disc — and follow the theme with it. */}
        <circle cx="5.4" cy="7" r="0.55" className="fill-abyss" stroke="none" />
        <circle cx="5.4" cy="9" r="0.55" className="fill-abyss" stroke="none" />
      </g>
    </svg>
  );
}

/**
 * The loosed arrow, drawn once at the flight span's left edge. Same anatomy
 * and stroke as the nocked one so the loose reads as the *same* arrow leaving,
 * not a swap — the nocked glyph blinks out and this appears in the next frame
 * of the shared clock.
 */
function ArrowInFlight(): ReactElement {
  return (
    <svg
      viewBox="0 0 20 16"
      className="absolute top-0 left-0 h-4 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 8 L17 8" />
      <path d="M14.6 5.6 L17 8 L14.6 10.4" />
    </svg>
  );
}
