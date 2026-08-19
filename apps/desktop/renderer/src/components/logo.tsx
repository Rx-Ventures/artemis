/**
 * The mark.
 *
 * The only hand-drawn icon left in the app. Everything else comes from
 * `lucide-react`, which is what the shadcn registry components already import —
 * two icon sets in one tree is the same mistake as two component systems.
 *
 * ## Terminator: a square frame around a half-lit moon
 *
 * This replaces a bow. The bow was Artemis the huntress and it was a good idea
 * with a drawing problem: its string is 15/512 of the box, so it thinned below
 * a pixel under about 20px and the mark collapsed to a bare arc with an arrow.
 * Anything wanting 16px needed a different drawing, which is most of the places
 * a mark is actually used.
 *
 * What is here instead states the design language rather than the mythology.
 * Sheet's one shape rule is that **square is what the machine produced and
 * round is what you are looking at** — code wells and diffs are square, things
 * a person operates are soft. The mark is that rule at 512: a square frame with
 * a circle inside it, split down the terminator line, half filled.
 *
 * The moon is not incidental. It is the other read on the name, and it is what
 * the accent was called before this palette (`--lunar`, now `--beam`).
 *
 * ### Why this one survives 16px when the bow did not
 *
 * Its thinnest element is a 24/512 stroke rather than the bow's 15/512, so at
 * 16px the lightest line is still comfortably over a device pixel on any
 * display this app runs on. There are four elements rather than five, none of
 * them tapering, and the silhouette is a square — which is the shape that
 * survives downsampling best, because its edges are axis-aligned.
 *
 * ### The neighbour problem, which is real
 *
 * A half-filled circle is what every contrast and theme toggle ever drawn looks
 * like, and lucide ships `contrast` and `moon`, both of which the app imports.
 * The frame is what separates them: no toggle is drawn inside a box. That is a
 * thinner defence than the bow had — a bow has no neighbour at all — and it is
 * the known cost of this mark. If the two are ever confused in use, the answer
 * is to thicken the frame rather than to redraw the moon.
 *
 * ## It is the app icon, not a cousin of it
 *
 * The paths below are the same as `apps/desktop/build/icon.svg` — same
 * coordinates, same stroke widths — because the thing in the dock and the thing
 * on the new-session page have to be one mark. Two drawings of the same idea
 * drift apart the first time either is touched, and the app then ships a logo
 * that is *almost* its icon, which reads as a mistake rather than as a family.
 * So: edit them together, or not at all. The `.png` and `.icns` beside the icon
 * are rasterised from that `.svg`, so a change there has to be re-exported too.
 *
 * The only deliberate differences are the two that have to differ:
 *
 *   - `currentColor` instead of the icon's literal hex, so the mark takes its
 *     colour from context — `--beam` on a dark surface, `--beam-ink` on a beam
 *     fill. The hex in the icon file *is* `--beam` resolved to sRGB; it is
 *     spelled out there only because an `.icns` has no cascade to inherit from.
 *   - A viewBox with no margin. The icon's generous inset is tile padding,
 *     which macOS wants and a mark sat next to a line of text does not.
 *
 * ## Geometry
 *
 * A 512 grid, axis-aligned, no rotation. The frame is a 368-square inset 72 on
 * every side at stroke 28. The moon is r=116 on centre at stroke 24, with the
 * left half filled — drawn as a single arc closing on its own diameter, so the
 * fill and the ring share an edge exactly rather than nearly.
 */

import type { ReactElement, SVGProps } from 'react';

export interface LogoMarkProps extends SVGProps<SVGSVGElement> {
  readonly size?: number;
}

export function LogoMark({ size = 18, ...rest }: LogoMarkProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="58 58 396 396"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {/* The frame. Square, because the machine made it. */}
      <rect x={72} y={72} width={368} height={368} strokeWidth={28} />
      {/* The lit half, closing on the diameter so it shares the ring's edge. */}
      <path d="M256 140a116 116 0 0 0 0 232Z" fill="currentColor" stroke="none" />
      {/* The moon. Round, because it is the thing you are looking at. */}
      <circle cx={256} cy={256} r={116} strokeWidth={24} />
    </svg>
  );
}
