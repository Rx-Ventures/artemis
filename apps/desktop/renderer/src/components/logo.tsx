/**
 * The mark.
 *
 * The only hand-drawn icon left in the app. Everything else comes from
 * `lucide-react`, which is what the shadcn registry components already import —
 * two icon sets in one tree is the same mistake as two component systems.
 *
 * This one stays hand-drawn because it is the product's identity: the bow, for
 * Artemis the huntress. It must never be swapped for a generic sparkle or a
 * borrowed logo.
 *
 * ## The bow, restored, in the current palette
 *
 * A moon in a square frame held this spot for a while. It was drawn to state the
 * design language rather than the mythology — Sheet's rule that square is what
 * the machine produced and round is what you are looking at — and it was chosen
 * for a legibility reason rather than a stylistic one, which is documented under
 * "the size floor" below and has not gone away.
 *
 * It went back because the bow is the name. A half-filled circle in a box is
 * also what every contrast and theme toggle ever drawn looks like, and lucide
 * ships both `contrast` and `moon` into a tree this app already imports from —
 * so the frame was the only thing separating the product's mark from a control.
 * A drawn bow has no such neighbour. Lucide's nearest misses are `target` and
 * `crosshair`, which are scopes: a different weapon, a different era, a
 * different silhouette.
 *
 * What is new is the colour. The mark is `currentColor` and takes it from
 * context; the accent it sits in is `--beam`, `oklch(86% 0.14 192)`, which is
 * where the palette landed after the bow was drawn — the violet the old drawing
 * carried is gone, and nothing here names a hue.
 *
 * ## It is the app icon, not a cousin of it
 *
 * The four paths below are copied verbatim from `apps/desktop/build/icon.svg` —
 * same coordinates, same stroke widths, same `translate/rotate` — because the
 * thing in the dock and the thing on the new-session page have to be one mark.
 * Two drawings of the same idea drift apart the first time either is touched,
 * and the app then ships a logo that is *almost* its icon, which reads as a
 * mistake rather than as a family. So: edit them together, or not at all. The
 * `.png` and `.icns` beside the icon are rasterised from that `.svg` by
 * `icon-build.sh`, so a change there has to be re-exported too.
 *
 * The only deliberate differences are the two that have to differ:
 *
 *   - `currentColor` instead of the icon's literal `#31eee8`, so the mark takes
 *     its colour from context — `--beam` on a dark surface, `--beam-ink` on a
 *     beam fill. The hex in the icon file *is* `--beam` resolved to sRGB; it is
 *     spelled out there only because an `.icns` has no cascade to inherit from.
 *   - A cropped `viewBox`. The icon's generous margin is tile inset, which macOS
 *     wants and a mark sat next to a line of text does not — uncropped, it
 *     renders at about two thirds the size it was asked for and reads as a
 *     rendering bug. The numbers are the art's own bounding box (stroke and
 *     round caps included), padded a little so the caps are not flush with the
 *     edge. Being square is not a coincidence: a shape on a 45° diagonal has the
 *     same extent both ways.
 *
 * ## Geometry
 *
 * A 512 grid, drawn axis-aligned and then rotated -45° so the arrow flies up and
 * to the right: the limb is a symmetric pair of cubics, the string a straight
 * V drawn back to the nocking point, the shaft a horizontal line from that point
 * out through the belly, and the head a filled triangle on the end.
 *
 * Stroke weight is graded rather than uniform — limb 38, shaft 30, string 15 —
 * which is the one place this parts company with the lucide grid beside it. It
 * has to: a bow's string is thin, and drawing it at the limb's weight produces a
 * closed shape that reads as a leaf.
 *
 * ### The size floor, which is real and is the known cost
 *
 * The string is 15/512 of the box, so it thins below a device pixel under about
 * 20px and the mark starts to read as a bare arc with an arrow. Every call site
 * in the app clears that comfortably — 30px in `App.tsx`, 34px in
 * `EmptyState.tsx` — and anything wanting a 16px version needs a redrawn mark,
 * not this one scaled down.
 *
 * Where it does bite is the iconset. `icon-build.sh` renders a true 16px tile
 * rather than resampling a larger one, and at that size the string is roughly a
 * third of a pixel: the dock and Finder at their smallest show the limb, the
 * shaft and the head, and no string. That is the trade this mark comes with. If
 * it ever needs fixing, thicken the string toward the shaft's 30 rather than
 * scaling the whole drawing up inside the tile — the second makes the bow crowd
 * a grid every other app sits on, and the first is the element that is actually
 * failing.
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
      viewBox="93 100 319 319"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <g transform="translate(36 -36) rotate(-45 256 256)">
        {/* The limb. */}
        <path d="M176 96C220 104 272 176 272 256C272 336 220 408 176 416" strokeWidth={38} />
        {/* The string, drawn back to the nocking point at the elbow of the V. */}
        <path d="M176 96L72 256L176 416" strokeWidth={15} />
        {/* The shaft, from that same point out past the belly. */}
        <path d="M72 256H326" strokeWidth={30} />
        {/* The head. Filled, so it stays solid at every size the string survives. */}
        <path d="M412 256L318 210L318 302Z" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
