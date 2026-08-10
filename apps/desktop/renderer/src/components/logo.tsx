/**
 * Libra's mark.
 *
 * The only hand-drawn icon left in the app. Everything else comes from
 * `lucide-react`, which is what the shadcn registry components already import —
 * two icon sets in one tree is the same mistake as two component systems.
 *
 * This one stays hand-drawn because it is the product's identity: a balance
 * beam, for "Libra". No icon library has it, and it must never be swapped for a
 * generic sparkle or a borrowed logo.
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
      <path d="M8 3.4v9.4M5.2 12.8h5.6" />
      <path d="M3.5 5.2h9" />
      <path d="M3.5 5.2v1.3M12.5 5.2v1.3" />
      <path d="M1.9 6.6 3.5 9.3 5.1 6.6" />
      <path d="M10.9 6.6 12.5 9.3 14.1 6.6" />
      <circle cx="8" cy="3.4" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
