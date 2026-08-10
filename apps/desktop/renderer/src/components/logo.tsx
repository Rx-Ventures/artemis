/**
 * Apollo's mark.
 *
 * The only hand-drawn icon left in the app. Everything else comes from
 * `lucide-react`, which is what the shadcn registry components already import —
 * two icon sets in one tree is the same mistake as two component systems.
 *
 * This one stays hand-drawn because it is the product's identity: the sun, for
 * Apollo. It must never be swapped for a generic sparkle or a borrowed logo.
 *
 * ## Why it is not lucide's `sun`
 *
 * It nearly is, and that was the problem. A plain eight-ray sun is one of the
 * most common glyphs there is, and this app already imports the icon set that
 * ships one — a mark indistinguishable from a stock icon is not a mark. So the
 * four cardinal rays run longer than the four diagonals. The asymmetry is
 * slight at 16px and unmistakable at 128, it reads as a compass rose as much as
 * a sun (Apollo drew a bow as well as the day), and it means the mark cannot be
 * mistaken for the `SunIcon` sitting two imports away.
 *
 * ## Geometry
 *
 * Drawn on the same 16×16 grid as every lucide glyph, so it optically matches
 * icons beside it: stroke 1.5, round caps, centre at (8, 8). The disc is filled
 * rather than stroked because a 2.5-radius ring closes into a dot at 16px
 * anyway — better to do that deliberately than to discover it. Rays stop 6.6
 * (cardinal) and 5.9 (diagonal) from centre, which keeps the round cap's
 * half-stroke inside the viewBox; a ray drawn to the edge gets clipped flat on
 * one side and stops matching the others.
 *
 * `currentColor` throughout, so the mark takes its colour from context:
 * `--ember` in the header, `--ember-ink` on a filled app-icon tile.
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
      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
      {/* Cardinal rays — the long ones. */}
      <path d="M8 3.6V1.4M8 12.4v2.2M3.6 8H1.4M12.4 8h2.2" />
      {/* Diagonals, drawn shorter so this is not a stock sun. */}
      <path d="M4.89 4.89 3.83 3.83M11.11 4.89l1.06-1.06M11.11 11.11l1.06 1.06M4.89 11.11l-1.06 1.06" />
    </svg>
  );
}
