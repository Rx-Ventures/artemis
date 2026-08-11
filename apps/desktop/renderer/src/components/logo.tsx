/**
 * The mark.
 *
 * The only hand-drawn icon left in the app. Everything else comes from
 * `lucide-react`, which is what the shadcn registry components already import —
 * two icon sets in one tree is the same mistake as two component systems.
 *
 * This one stays hand-drawn because it is the product's identity: the moon, for
 * Artemis. It must never be swapped for a generic sparkle or a borrowed logo.
 *
 * ## Why it is not lucide's `moon`, and not its `contrast` either
 *
 * The mark this replaced was a sun, and it had the same problem in the same
 * shape: a plain eight-ray sun is one of the most common glyphs there is, and
 * the app imports the icon set that ships one. It solved that by running the
 * four cardinal rays longer than the four diagonals.
 *
 * A moon has *two* stock glyphs to avoid, which is worse:
 *
 *   - `moon` is a plain crescent with no disc behind it. Drawing a crescent is
 *     therefore not an option at all — it is the stock icon.
 *   - `contrast` is a circle with a half-disc inside it, straight-edged and
 *     inset from the rim. A disc split down a straight vertical line lands on
 *     it closely enough to read as "the theme toggle", which is the one thing a
 *     product mark must never be mistaken for.
 *
 * So: the full circumference stays (which rules out `moon`), and the terminator
 * is an *arc*, not a line (which rules out `contrast`). What is left is a real
 * lunar phase rather than a diagram of one. The curve is slight at 16px and
 * unmistakable at 128 — the same trade the sun's ray asymmetry made, and it
 * fails the same way if flattened, so it must not be "simplified" to a chord.
 *
 * ## Geometry
 *
 * Drawn on the same 16×16 grid as every lucide glyph, so it optically matches
 * icons beside it: stroke 1.5, round caps, centre at (8, 8). The disc is r 5.5,
 * which puts the stroke's outer edge at 6.25 from centre and keeps the whole
 * mark inside the viewBox — a circle drawn to the edge gets clipped flat and
 * stops reading as round.
 *
 * The terminator is an elliptical arc, rx 1.6 against the disc's own ry 5.5,
 * bowed towards the shadow so the lit limb is a waxing phase just past first
 * quarter. It is filled rather than stroked: at 16px a stroked terminator and
 * the rim it meets close into a solid blob, and the shadow — the thing that
 * makes this a moon — is the first casualty. Filling the lit side keeps the
 * shadow as negative space, which survives every size.
 *
 * `currentColor` throughout, so the mark takes its colour from context:
 * `--lunar` in the header, `--lunar-ink` on a filled app-icon tile.
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
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {/* The full disc. Keeping the whole rim is what separates this from a
          stock crescent. */}
      <circle cx="8" cy="8" r="5.5" />
      {/* The lit limb: down the curved terminator, back up the rim. */}
      <path d="M8 2.5A1.6 5.5 0 0 0 8 13.5A5.5 5.5 0 0 0 8 2.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
