/**
 * OKLCH → sRGB, and WCAG relative luminance.
 *
 * This exists so the palette's claims can be *checked* rather than asserted.
 * `index.css` says every token falls inside sRGB, that every ink and semantic
 * colour clears AA on both grounds, and that the accent and the five semantics
 * are at least 40° apart. Those are the kind of statements that are true on the
 * day they are written and quietly stop being true the first time someone
 * nudges a number, so `palette.test.ts` reads the stylesheet and re-derives
 * them on every run.
 *
 * It is not a colour library and should not grow into one. Three functions,
 * enough to answer "does this clip" and "can this be read".
 *
 * The conversion is the standard one: OKLCH → OKLab (polar to cartesian) →
 * linear sRGB via Björn Ottosson's matrices. Deliberately *not* clamped —
 * a component outside [0, 1] is the signal that a colour is out of gamut, and
 * clamping it away is exactly the bug this is meant to catch.
 */

/** A colour as it is written in the stylesheet: `oklch(86% 0.14 192)`. */
export interface Oklch {
  /** Lightness, as the percentage written in CSS: 86, not 0.86. */
  readonly l: number;
  readonly c: number;
  /** Hue in degrees. */
  readonly h: number;
}

/** Linear-light sRGB, unclamped, so out-of-gamut values stay visible. */
export function toLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const L = l / 100;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/**
 * Whether the colour survives being displayed on an sRGB screen.
 *
 * The epsilon absorbs floating-point noise at the exact boundary — pure white
 * lands a few ulps above 1 — without admitting a colour that genuinely clips.
 */
export function inGamut(colour: Oklch, epsilon = 1e-4): boolean {
  return toLinearSrgb(colour).every((v) => v >= -epsilon && v <= 1 + epsilon);
}

/**
 * WCAG 2.x contrast ratio.
 *
 * Clamps before measuring, on purpose and unlike everything else here: an
 * out-of-gamut colour is reported by `inGamut`, and what a contrast number
 * should describe is what the screen will actually show, which is the clamped
 * value. Ratios run 1 (identical) to 21 (black on white).
 */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const luminance = (colour: Oklch): number => {
    const [r, g, bl] = toLinearSrgb(colour).map((v) => Math.min(1, Math.max(0, v)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Shortest angular distance between two hues, in degrees: always 0–180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
