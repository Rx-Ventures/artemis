/**
 * Provider marks — whose model is answering.
 *
 * The transcript puts one of these on every agent turn, chosen from the
 * profile the run is billed to. It is the one place in the app where a logo
 * that is not ours appears, and that is deliberate: when a window can be
 * signed into Claude in one column and Codex in another, "which model wrote
 * this" is a fact about the transcript, not a setting to go and look up.
 *
 * ## Monochrome, on purpose
 *
 * Both marks are drawn in `currentColor` rather than their brand colours.
 * Anthropic's clay sits within a few degrees of `--amber`, which this app has
 * already spent meaning on — it is the warning hue, used by dropped events,
 * denied permissions and interrupted runs. A clay avatar beside an amber
 * badge would make the palette say two different things with one colour, and
 * the palette is load-bearing here in a way brand fidelity is not.
 *
 * The silhouettes carry the recognition regardless. Anthropic's `A` and
 * OpenAI's knot are both distinctive in outline at 14px, which is the whole
 * job. If brand colour is ever wanted back, it belongs on the avatar ring
 * rather than the glyph, so the mark stays legible on `--raised`.
 *
 * ## Geometry
 *
 * The two brand marks are the official glyphs on their native 24×24 grid,
 * filled rather than stroked, so they must not be given a `strokeWidth` to
 * "match" lucide — filled art and 1.5px stroked art are matched by *weight*,
 * not by stroke, and these are already drawn to sit right beside text.
 *
 * `opencode` has no published mark, so it gets a lucide glyph instead of an
 * invented one. A made-up logo for someone else's project is worse than an
 * honest generic icon, and the provider is not implemented yet anyway.
 */

import type { ReactElement, SVGProps } from 'react';
import { SquareTerminalIcon } from 'lucide-react';
import type { ProviderId } from '@rx-artemis/protocol';

export interface ProviderMarkProps extends SVGProps<SVGSVGElement> {
  readonly size?: number;
  /** Accessible name. Omit to render the mark as decoration. */
  readonly title?: string;
}

/** Shared plumbing: size, colour, and whether the glyph is announced. */
function markProps({ size = 14, title, ...rest }: ProviderMarkProps) {
  return {
    width: size,
    height: size,
    fill: 'currentColor',
    ...(title === undefined
      ? { 'aria-hidden': true as const, focusable: false as const }
      : { role: 'img' as const }),
    ...rest,
  };
}

/** Anthropic's `A`. Used for the `claude` provider. */
export function AnthropicMark({ title, ...props }: ProviderMarkProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...markProps({ title, ...props })}>
      {title === undefined ? null : <title>{title}</title>}
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  );
}

/** OpenAI's knot. Used for the `codex` provider. */
export function OpenAiMark({ title, ...props }: ProviderMarkProps): ReactElement {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...markProps({ title, ...props })}>
      {title === undefined ? null : <title>{title}</title>}
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

/**
 * The mark for a provider that publishes none.
 *
 * Two providers need it and neither has a logo to borrow: OpenCode ships no
 * mark, and a local inference server is a program on your machine rather than
 * a company with an identity. Taking a vendor's visual identity for either
 * would breach the rule the README sets in Naming, so both get the same
 * deliberately generic glyph.
 */
export function TerminalMark({ size = 14, title, ...props }: ProviderMarkProps): ReactElement {
  return (
    <SquareTerminalIcon
      width={size}
      height={size}
      {...(title === undefined ? { 'aria-hidden': true, focusable: false } : { role: 'img' })}
      {...props}
    >
      {title === undefined ? null : <title>{title}</title>}
    </SquareTerminalIcon>
  );
}

/** Kept as a name so existing imports keep reading naturally. */
export const OpencodeMark = TerminalMark;

const MARKS: Readonly<Record<ProviderId, (props: ProviderMarkProps) => ReactElement>> = {
  claude: AnthropicMark,
  codex: OpenAiMark,
  opencode: OpencodeMark,
  // No vendor mark: the provider is a local server rather than a company, and
  // borrowing LM Studio's identity would breach the Naming rule the README
  // sets for exactly this situation. The generic terminal mark is the fallback
  // every unbranded provider gets.
  lmstudio: TerminalMark,
};

export interface ProviderLogoProps extends ProviderMarkProps {
  readonly providerId: ProviderId;
}

/**
 * The mark for one provider.
 *
 * A lookup rather than a `switch` so adding a fourth provider to `ProviderId`
 * fails the build here until it has a glyph, instead of silently falling
 * through to a default and shipping a blank avatar.
 */
export function ProviderLogo({ providerId, ...props }: ProviderLogoProps): ReactElement {
  const Mark = MARKS[providerId];
  return <Mark {...props} />;
}
